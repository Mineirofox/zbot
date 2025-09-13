const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { scheduleReminder, restoreReminders } = require("./scheduler"); // 🔥 atualizado
const { chatResponse, extractReminder, extractForwardMessage } = require("./openai");
const { setContact, getContact } = require("./contactsManager"); // ✅ CORRIGIDO
const { clearContext } = require("./contextManager");

if (process.platform === 'win32') {
  const exec = require('child_process').exec;
  const cmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';
  exec(`powershell -Command \"${cmd}\"`, (error) => {
    if (!error) console.log('[ENCODING] UTF-8 ativado ✔');
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

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      logger.info({ event: "connection.open" });
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
      // ✅ CORRIGIDO: Usando o nome correto da função "setContact"
      // Nota: Isso salvará/atualizará o contato com o nome de perfil do WhatsApp a cada mensagem.
      await setContact(m.pushName, from);
    }

    // primeiro tenta extrair mensagem para terceiro
    const forward = await extractForwardMessage(text, from);
    if (forward?.shouldSend) {
      // ✅ CORRIGIDO: Usando o nome correto da função "getContact"
      const recipientJid = await getContact(forward.recipient);
      
      // Se não encontrar o JID pelo apelido, não é possível enviar
      if (!recipientJid) {
          await sock.sendMessage(from, { text: `❌ Contato "${forward.recipient}" não encontrado. Use o comando para adicionar.` });
          return;
      }

      await scheduleReminder(
        {
          from,
          recipient: recipientJid, // Usar o JID encontrado
          date: forward.date,
          time: forward.time,
          timezone: forward.timezone,
          content: forward.content,
        },
        async (to, content) => {
          await sock.sendMessage(to, { text: content });
        }
      );
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
          await sock.sendMessage(to, { text: content });
        },
        async (creator, reminderObj) => {
          await sock.sendMessage(creator, {
            text: `✅ Seu lembrete foi entregue: "${reminderObj.content}"`,
          });
        }
      );
      await sock.sendMessage(from, {
        text: `⏰ Lembrete agendado para ${reminder.date} às ${reminder.time}.`,
      });
      return;
    }

    // se não for lembrete nem mensagem para terceiros → resposta normal
    const reply = await chatResponse(text, from);
    await sock.sendMessage(from, { text: reply });
  });

  // restaura lembretes ao iniciar
  await restoreReminders(
    async (to, content) => {
      await sock.sendMessage(to, { text: content });
    },
    async (creator, reminderObj) => {
      await sock.sendMessage(creator, {
        text: `✅ Seu lembrete foi entregue: "${reminderObj.content}"`,
      });
    }
  );

  logger.info({ event: "bot.start" });
}

startBot().catch((err) => {
  logger.error({ event: "bootstrap.failed", error: err.message });
});