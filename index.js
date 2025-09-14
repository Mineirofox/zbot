const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { scheduleReminder, restoreReminders } = require("./scheduler");
const { chatResponse, extractReminder, extractForwardMessage } = require("./openai");
const { setContact, getContact } = require("./contactsManager");
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

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      logger.info({ event: "connection.open" });

      // 🔥 restaura lembretes apenas quando a conexão abre
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

    // primeiro tenta extrair mensagem para terceiro
    const forward = await extractForwardMessage(text, from);
    if (forward?.shouldSend) {
      const recipientJid = await getContact(forward.recipient);
      if (!recipientJid) {
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

  logger.info({ event: "bot.start" });
}

startBot().catch((err) => {
  logger.error({ event: "bootstrap.failed", error: err.message });
});
