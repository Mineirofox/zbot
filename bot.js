const baileys = require('@whiskeysockets/baileys');
const {
  DisconnectReason,
  makeWASocket,
  downloadContentFromMessage
} = baileys;

const {
  extractReminder,
  chatResponse,
  transcribeAudio,
  generateReminderAlert,
  summarizeDocument,
  extractAnyText
} = require('./openai');
const { scheduleReminder, getUserReminders, clearUserReminders } = require('./scheduler');
const { appendToContext } = require('./contextManager');
const logger = require('./logger');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const mime = require('mime-types');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezonePlugin = require('dayjs/plugin/timezone');
const pino = require('pino');

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

ffmpeg.setFfmpegPath(ffmpegStatic);

const TEMP_DIR = path.join(os.tmpdir(), 'whatsapp-bot');
const ensureTempDir = async () => {
  try {
    await fs.access(TEMP_DIR);
  } catch {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  }
};

let sock;
let state, saveCreds;

// === autenticação ===
async function initAuth() {
  if (typeof baileys.useSingleFileAuthState === 'function') {
    const { state: st, saveCreds: sc } = baileys.useSingleFileAuthState('auth_info.json');
    state = st;
    saveCreds = sc;
  } else {
    const res = await baileys.useMultiFileAuthState('auth_info_baileys');
    state = res.state;
    saveCreds = res.saveCreds;
  }
}

async function sendMessage(jid, text, options = {}) {
  try {
    const safeText = typeof text === "string" ? text : String(text || "");
    await sock.sendMessage(jid, { text: safeText, ...options });
    await appendToContext(jid, 'assistant', safeText, 'text');
    logger.infoWithContext('whatsapp.send', { to: jid, preview: safeText.slice(0, 50) });
  } catch (err) {
    logger.errorWithContext('whatsapp.send.error', err);
  }
}

async function handleMessage(msg) {
  const from = msg.key.remoteJid;
  let text = '';
  let origin = 'text';

  try {
    // === extrair conteúdo do WhatsApp ===
    if (msg.message?.extendedTextMessage?.text) {
      text = msg.message.extendedTextMessage.text;
    } else if (msg.message?.conversation) {
      text = msg.message.conversation;
    } else if (msg.message?.imageMessage) {
      text = msg.message.imageMessage?.caption || '';
      origin = 'image';
    } else if (msg.message?.audioMessage) {
      origin = 'audio';
    } else if (msg.message?.documentMessage) {
      origin = 'document';
      text = msg.message.documentMessage?.caption || '';
    } else if (msg.message?.videoMessage) {
      text = msg.message.videoMessage?.caption || '';
      origin = 'video';
    } else if (msg.message?.buttonsResponseMessage?.selectedDisplayText) {
      text = msg.message.buttonsResponseMessage.selectedDisplayText;
    } else if (msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId) {
      text = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
    } else {
      logger.warnWithContext('unsupported.message', { from, keys: Object.keys(msg.message || {}) });
      return;
    }

    text = typeof text === "string" ? text : String(text || "");
    logger.infoWithContext('message.received', { from, origin, textPreview: text.slice(0, 80) });

    await appendToContext(from, 'user', text, origin);
    await sock.sendPresenceUpdate('composing', from);

    // === LISTAR LEMBRETES (detecção flexível) ===
    if (/\blembretes?\b/i.test(text) || /^!lembretes\b/i.test(text)) {
      const reminders = await getUserReminders(from);
      if (reminders.length > 0) {
        const reminderList = reminders
          .map((r, i) => {
            const dateStr = dayjs(r.scheduledAt).format('DD/MM/YYYY [às] HH:mm');
            return `\n#️⃣ ${i + 1}\n📝 *${r.content}*\n⏰ ${dateStr}\n➖➖➖➖➖`;
          })
          .join("\n");

        return sendMessage(
          from,
          `📋 *Seus lembretes ativos* 📋\n${reminderList}\n\n✏️ Para apagar um lembrete específico use: *!apagar <número>*`,
          {
            buttons: [
              { buttonId: 'novo', buttonText: { displayText: '➕ Criar novo' }, type: 1 },
              { buttonId: 'limpar', buttonText: { displayText: '🗑️ Limpar todos' }, type: 1 }
            ],
            headerType: 1
          }
        );
      } else {
        return sendMessage(from, '🔕 Você ainda não tem lembretes ativos.\n✨ Dica: peça "me lembra de..." para criar um.');
      }
    }

    // === LIMPAR TODOS ===
    if (["!limpar-lembretes", "limpar"].includes(text.toLowerCase())) {
      await clearUserReminders(from);
      logger.infoWithContext('reminders.cleared', { from });
      return sendMessage(from, '✅ Todos os seus lembretes foram apagados.');
    }

    // === APAGAR INDIVIDUAL ===
    if (text.toLowerCase().startsWith("!apagar")) {
      const parts = text.trim().split(" ");
      if (parts.length < 2 || isNaN(parts[1])) {
        return sendMessage(from, "❌ Uso incorreto. Exemplo: *!apagar 2*");
      }
      const index = parseInt(parts[1], 10) - 1;
      const reminders = await getUserReminders(from);

      if (index < 0 || index >= reminders.length) {
        return sendMessage(from, "⚠️ Número inválido. Use *!lembretes* para ver a lista e escolha um número válido.");
      }

      const toDelete = reminders[index];
      const all = await getUserReminders(from);
      const left = all.filter(r => r.id !== toDelete.id);

      await fs.writeFile('./reminders.json', JSON.stringify(left, null, 2));

      logger.infoWithContext('reminder.deleted', { from, deleted: toDelete.content });
      return sendMessage(from, `🗑️ Lembrete removido: *${toDelete.content}*`);
    }

    // === processamento de mídias ===
    if (origin !== 'text' && msg.message[origin + "Message"]) {
      const mediaPath = path.join(TEMP_DIR, `media-${msg.key.id}`);
      const mimetype = msg.message[origin + "Message"].mimetype;
      const extension = mime.extension(mimetype) || 'bin';
      const filePath = `${mediaPath}.${extension}`;
      const stream = await downloadContentFromMessage(msg.message[origin + "Message"], origin);

      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      await fs.writeFile(filePath, buffer);

      try {
        if (origin === 'audio') {
          const mp3Path = `${mediaPath}.mp3`;
          await new Promise((resolve, reject) => {
            ffmpeg(filePath)
              .audioCodec('libmp3lame')
              .on('error', reject)
              .on('end', resolve)
              .save(mp3Path);
          });
          text = await transcribeAudio(mp3Path);
          logger.infoWithContext('media.audio.transcribed', { from, length: text.length });
          await fs.unlink(filePath).catch(() => {});
          await fs.unlink(mp3Path).catch(() => {});
        } else if (origin === 'document' || origin === 'image') {
          const fileText = await extractAnyText(filePath, mimetype);
          if (fileText) {
            text = await summarizeDocument(fileText);
            logger.infoWithContext('media.document.summary', { from, chars: fileText.length });
          }
          await fs.unlink(filePath).catch(() => {});
        }
      } catch (err) {
        logger.errorWithContext('media.process.error', err);
        return sendMessage(from, "⚠️ Não consegui processar esse arquivo. Pode tentar novamente?");
      }
    }

    // === lembretes automáticos extraídos ===
    const reminder = await extractReminder(text, from);
    if (reminder?.shouldRemind) {
      const scheduledAt = dayjs(`${reminder.date} ${reminder.time}`).tz(reminder.timezone, true);
      if (scheduledAt.isValid() && scheduledAt.isAfter(dayjs())) {
        const alert = await generateReminderAlert(reminder.content);
        const reminderObj = { from, ...reminder, scheduledAt: scheduledAt.toISOString() };
        await scheduleReminder(reminderObj, async (to, content) => {
          await sendMessage(to, content);
        });
        logger.infoWithContext('reminder.scheduled', { from, at: scheduledAt.toString(), content: reminder.content });
        return sendMessage(from, `✅ Lembrete criado!\n⏰ ${scheduledAt.format('DD/MM/YYYY [às] HH:mm')}`);
      } else {
        logger.warnWithContext('reminder.invalid', { from, reminder });
        return sendMessage(from, "⚠️ Não consegui agendar o lembrete. Verifique a data/hora.");
      }
    }

    // === resposta normal ===
    try {
      logger.infoWithContext('chatResponse.start', { from });
      const reply = await chatResponse(text, from);
      await sendMessage(from, reply);
      logger.infoWithContext('chatResponse.success', { from });
    } catch (err) {
      logger.errorWithContext('chatResponse.error', err);
      await sendMessage(from, "❌ Ocorreu um erro ao tentar responder. Pode repetir sua pergunta?");
    }
  } catch (err) {
    logger.errorWithContext('message.handler.fatal', err);
    await sendMessage(from, "❌ Ocorreu um erro inesperado. Pode tentar novamente?");
  }
}

async function startBot() {
  logger.infoWithContext('bot.start');
  await ensureTempDir();
  await initAuth();

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }) // silencia Baileys
  });

  if (saveCreds) {
    sock.ev.on('creds.update', saveCreds);
  }

  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update'];
      if (qr) {
        const qrcode = require('qrcode-terminal');
        console.log("📲 Escaneie o QR abaixo para conectar:");
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.warnWithContext('connection.closed', { shouldReconnect });
        if (shouldReconnect) startBot();
      } else if (connection === 'open') {
        logger.infoWithContext('connection.open');
        console.log("🤖 Bot pronto para receber mensagens!");
      }
    }

    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages) {
        if (msg.key.fromMe) continue;
        try {
          await handleMessage(msg);
        } catch (err) {
          logger.errorWithContext('messages.upsert.error', err);
        }
      }
    }
  });
}

module.exports = { startBot, sendMessage };