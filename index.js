const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const logger = require("./logger");
const { scheduleReminder, restoreReminders } = require("./scheduler");
const { chatResponse, extractReminder, extractForwardMessage, humanizeForwardedMessage } = require("./openai");
const { setContact, getContact } = require("./contactsManager");

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

      // 🔥 restaura lembretes apenas quando a conexão abre
      await restoreReminders(
        async (to, content, reminderObj) => {
          const typing = startComposing(sock, to);
          // humanizar se for mensagem para outro contato
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

    // salvar nome do contato
    if (m.pushName) {
      await setContact(m.pushName, from);
    }

    const typing = startComposing(sock, from);

    try {
      // primeiro tenta extrair mensagem para terceiro
      const forward = await extractForwardMessage(text, from);
      if (forward?.shouldSend) {
        const recipientJid = await getContact(forward.recipient);
        if (!recipientJid) {
          await stopComposing(sock, typing, from);
          await sock.sendMessage(from, { text: `❌ Contato "${forward.recipient}" não encontrado. Use o comando para adicionar.` });
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
            fromAlias: m.pushName || from.replace(/@s\.whatsapp\.net$/, ""), // quem pediu
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
        await sock.sendMessage(from, {
          text: `📨 Mensagem agendada para ${forward.recipient}.`,
        });
        return;
      }

      // tenta extrair lembrete pessoal
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
        await sock.sendMessage(from, {
          text: `⏰ Lembrete agendado para ${reminder.date} às ${reminder.time}.`,
        });
        return;
      }

      // se não for lembrete nem mensagem para terceiros → resposta normal
      const reply = await chatResponse(text, from);
      await stopComposing(sock, typing, from);
      await sock.sendMessage(from, { text: reply });

    } catch (err) {
      await stopComposing(sock, typing, from);
      logger.errorWithContext("messages.upsert.error", err);
      await sock.sendMessage(from, { text: "⚠️ Erro ao processar sua mensagem." });
    }
  });

  logger.info({ event: "bot.start" });
}

startBot().catch((err) => {
  logger.error({ event: "bootstrap.failed", error: err.message });
});
