const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const logger = require("./logger");
const { scheduleReminder, restoreReminders, getUserReminders } = require("./scheduler");
const { chatResponse, extractReminder, extractForwardMessage, humanizeForwardedMessage } = require("./openai");
const { setContact, getContact, listContacts, removeContact } = require("./contactsManager");

// === helpers de digitação ===
function startComposing(sock, jid) {
  sock.sendPresenceUpdate("composing", jid).catch(() => {});
  return setInterval(() => {
    sock.sendPresenceUpdate("composing", jid).catch(() => {});
  }, 4000);
}

async function stopComposing(sock, interval, jid) {
  clearInterval(interval);
  await sock.sendPresenceUpdate("paused", jid).catch(() => {});
}

// === utilitários para contatos ===
function normalizeToJid(input) {
  if (!input) return null;
  input = ("" + input).trim();
  if (input.includes("@")) {
    const base = input.split("@")[0];
    return base + "@s.whatsapp.net";
  }
  const digits = input.replace(/\D/g, "");
  if (digits.length < 6) return null;
  let normalized = digits;
  if (normalized.length <= 11) normalized = "55" + normalized;
  return `${normalized}@s.whatsapp.net`;
}

function parseEstabelecer(text) {
  const t = text.trim();
  const matchComo = t.match(/^!estabelecer\s+(.+?)\s+como\s+(.+)$/i);
  if (matchComo) {
    const left = matchComo[1].trim();
    const right = matchComo[2].trim();
    const leftDigits = left.replace(/\D/g, "");
    const rightDigits = right.replace(/\D/g, "");
    if (leftDigits.length >= 6 && leftDigits.length > rightDigits.length) {
      return { number: left, alias: right };
    } else if (rightDigits.length >= 6 && rightDigits.length > leftDigits.length) {
      return { number: right, alias: left };
    } else {
      return { number: left, alias: right };
    }
  }
  const matchTwo = t.match(/^!estabelecer\s+(\+?[0-9\-\s().]{6,})\s+(.+)$/i);
  if (matchTwo) {
    return { number: matchTwo[1].trim(), alias: matchTwo[2].trim() };
  }
  const matchTwoInv = t.match(/^!estabelecer\s+(.+?)\s+(\+?[0-9\-\s().]{6,})$/i);
  if (matchTwoInv) {
    return { number: matchTwoInv[2].trim(), alias: matchTwoInv[1].trim() };
  }
  return null;
}

if (process.platform === "win32") {
  const exec = require("child_process").exec;
  const cmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';
  exec(`powershell -Command \"${cmd}\"`, (error) => {
    if (!error) console.log("[ENCODING] UTF-8 ativado ✔");
  });
}

// === inicialização principal ===
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      logger.info({ event: "connection.open" });
      await restoreReminders(
        async (to, content, reminderObj) => {
          const typing = startComposing(sock, to);
          let finalMsg = content;
          if (reminderObj?.recipient && reminderObj?.fromAlias) {
            finalMsg = await humanizeForwardedMessage(reminderObj.content, reminderObj.fromAlias);
          }
          await sock.sendMessage(to, { text: finalMsg });
          await stopComposing(sock, typing, to);
        },
        async (creator, reminderObj) => {
          const typing = startComposing(sock, creator);
          await sock.sendMessage(creator, {
            text: `✅ Sua mensagem/lembrete foi entregue: "${reminderObj.content}"`,
          });
          await stopComposing(sock, typing, creator);
        }
      );
    } else if (connection === "close") {
      logger.error({ event: "connection.close", lastDisconnect });
      startBot();
    }
  });

  // mensagens recebidas
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const from = m.key.remoteJid;
    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.imageMessage?.caption ||
      "";

    logger.infoWithContext("message.received", { from, text });

    if (!text || !text.trim()) {
      return; // ignora mensagens vazias
    }

    const lower = text.trim().toLowerCase();

    // === comandos de contatos e listagem ===
    try {
      if (lower.startsWith("!estabelecer")) {
        const parsed = parseEstabelecer(text);
        if (!parsed || !parsed.number || !parsed.alias) {
          await sock.sendMessage(from, { text: "❌ Uso inválido. Exemplo: !estabelecer 5533999999999 como Juliana" });
          return;
        }
        const jid = normalizeToJid(parsed.number);
        if (!jid) {
          await sock.sendMessage(from, { text: "❌ Número inválido." });
          return;
        }
        await setContact(from, parsed.alias, jid);
        await sock.sendMessage(from, { text: `✅ Contato salvo: *${parsed.alias}* → ${jid.replace(/@s\.whatsapp\.net$/, "")}` });
        return;
      }

      if (lower === "!contatos") {
        const contacts = await listContacts(from);
        if (!contacts || Object.keys(contacts).length === 0) {
          await sock.sendMessage(from, { text: "📭 Nenhum contato salvo." });
          return;
        }
        const list = Object.entries(contacts)
          .map(([alias, jid], i) => `#${i + 1} • *${alias}* — ${jid.replace(/@s\.whatsapp\.net$/, "")}`)
          .join("\n");
        await sock.sendMessage(from, { text: `📇 *Seus contatos salvos:*\n\n${list}` });
        return;
      }

      if (lower.startsWith("!remover-contato")) {
        const parts = text.split(/\s+/).slice(1);
        if (parts.length === 0) {
          await sock.sendMessage(from, { text: "❌ Uso: !remover-contato <apelido>" });
          return;
        }
        const alias = parts.join(" ").trim();
        await removeContact(from, alias);
        await sock.sendMessage(from, { text: `🗑️ Contato *${alias}* removido (se existia).` });
        return;
      }

      if (lower === "!listar") {
        const reminders = await getUserReminders(from);

        if (!reminders || reminders.length === 0) {
          await sock.sendMessage(from, { text: "📭 Você não tem lembretes ou mensagens agendadas." });
          return;
        }

        const pessoais = reminders.filter(r => !r.recipient || r.recipient === from);
        const terceiros = reminders.filter(r => r.recipient && r.recipient !== from);

        let resposta = "📋 *Seus lembretes e mensagens agendadas:*\n\n";

        if (pessoais.length > 0) {
          resposta += "⏰ *Lembretes pessoais:*\n";
          pessoais.forEach((r, i) => {
            resposta += `${i + 1}. ${r.content}\n   🗓️ ${r.date} às ${r.time}\n\n`;
          });
        } else {
          resposta += "⏰ *Lembretes pessoais:* Nenhum.\n\n";
        }

        if (terceiros.length > 0) {
          resposta += "📨 *Mensagens para contatos:*\n";
          terceiros.forEach((r, i) => {
            resposta += `${i + 1}. Para *${r.recipientAlias || r.recipient}*\n   ✉️ ${r.content}\n   🗓️ ${r.date} às ${r.time}\n\n`;
          });
        } else {
          resposta += "📨 *Mensagens para contatos:* Nenhuma.\n";
        }

        await sock.sendMessage(from, { text: resposta.trim() });
        return;
      }
    } catch (cmdErr) {
      logger.errorWithContext("commands.contact.error", cmdErr);
      await sock.sendMessage(from, { text: "⚠️ Erro ao processar comando de contatos." });
      return;
    }

    // === fluxo normal ===
    const typing = startComposing(sock, from);

    try {
      const forward = await extractForwardMessage(text, from);
      if (forward?.shouldSend) {
        const recipientJid = await getContact(from, forward.recipient);
        if (!recipientJid) {
          await stopComposing(sock, typing, from);
          await sock.sendMessage(from, { text: `❌ Contato "${forward.recipient}" não encontrado.` });
          return;
        }
        await scheduleReminder(
          {
            from,
            recipient: recipientJid,
            date: forward.date,
            time: forward.time,
            timezone: forward.timezone,
            content: forward.content,
            fromAlias: m.pushName || from.replace(/@s\.whatsapp\.net$/, ""),
            recipientAlias: forward.recipient
          },
          async (to, content, reminderObj) => {
            const typingFwd = startComposing(sock, to);
            const finalMsg = await humanizeForwardedMessage(reminderObj.content, reminderObj.fromAlias);
            await sock.sendMessage(to, { text: finalMsg });
            await stopComposing(sock, typingFwd, to);
          },
          async (creator, reminderObj) => {
            const typingConf = startComposing(sock, creator);
            await sock.sendMessage(creator, {
              text: `✅ Sua mensagem para ${forward.recipient} foi entregue.`,
            });
            await stopComposing(sock, typingConf, creator);
          }
        );
        await stopComposing(sock, typing, from);
        await sock.sendMessage(from, { text: `📨 Mensagem agendada para ${forward.recipient}.` });
        return;
      }

      const reminder = await extractReminder(text, from);
      if (reminder?.shouldRemind) {
        await scheduleReminder(
          { from, ...reminder },
          async (to, content) => {
            const typingRem = startComposing(sock, to);
            await sock.sendMessage(to, { text: content });
            await stopComposing(sock, typingRem, to);
          },
          async (creator, reminderObj) => {
            const typingConf = startComposing(sock, creator);
            await sock.sendMessage(creator, {
              text: `✅ Seu lembrete foi entregue: "${reminderObj.content}"`,
            });
            await stopComposing(sock, typingConf, creator);
          }
        );
        await stopComposing(sock, typing, from);
        await sock.sendMessage(from, { text: `⏰ Lembrete agendado para ${reminder.date} às ${reminder.time}.` });
        return;
      }

      const reply = await chatResponse(text, from);
      await stopComposing(sock, typing, from);
      if (reply) {
        await sock.sendMessage(from, { text: reply });
      }
    } catch (err) {
      await stopComposing(sock, typing, from);
      logger.errorWithContext("messages.upsert.error", err);
    }
  });

  logger.info({ event: "bot.start" });
}

startBot().catch((err) => {
  logger.error({ event: "bootstrap.failed", error: err.message });
});
