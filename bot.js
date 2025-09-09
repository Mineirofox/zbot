const { DisconnectReason, makeWASocket, useMultiFileAuthState, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { extractReminder, chatResponse, transcribeAudio, generateReminderAlert, summarizeDocument, extractAnyText } = require('./openai');
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

async function sendMessage(jid, text, options = {}) {
  try {
    const safeText = typeof text === "string" ? text : String(text || "");
    await sock.sendMessage(jid, { text: safeText, ...options });
    await appendToContext(jid, 'assistant', safeText, 'text');
  } catch (err) {
    logger.error({ event: 'whatsapp.send.error', error: err.message });
  }
}

async function handleMessage(msg) {
  const from = msg.key.remoteJid;
  let text = '';
  let origin = 'text';

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
    logger.warn({ event: 'unsupported.message', type: Object.keys(msg.message || {})[0] });
    return;
  }

  text = typeof text === "string" ? text : String(text || "");
  logger.info({ event: 'message.received', from, origin, text });
  await appendToContext(from, 'user', text, origin);

  // ⚡ Sempre mostrar "digitando..." enquanto processa
  await sock.sendPresenceUpdate('composing', from);

  // === Comando: listar lembretes ===
  if (["!lembretes", "listar lembretes", "meus lembretes", "listar"].includes(text.toLowerCase())) {
    const reminders = await getUserReminders(from);
    if (reminders.length > 0) {
      const reminderList = reminders
        .map(r => `- ${r.content} ⏰ ${dayjs(r.scheduledAt).format('DD/MM/YYYY [às] HH:mm')}`)
        .join('\n');

      return sendMessage(from, `📋 Aqui estão seus lembretes ativos:\n\n${reminderList}\n\nO que deseja fazer agora?`, {
        buttons: [
          { buttonId: 'novo', buttonText: { displayText: '➕ Novo lembrete' }, type: 1 },
          { buttonId: 'limpar', buttonText: { displayText: '🗑️ Limpar todos' }, type: 1 }
        ],
        headerType: 1
      });
    } else {
      return sendMessage(from, '🔕 Você ainda não tem lembretes ativos.\nQuer criar um agora? Basta me dizer, por exemplo:\n\n👉 "Me lembre amanhã às 9h de beber água 💧"');
    }
  }

  // === Comando: apagar lembretes ===
  if (["!limpar-lembretes", "limpar"].includes(text.toLowerCase())) {
    await clearUserReminders(from);
    return sendMessage(from, '✅ Todos os seus lembretes foram apagados.');
  }

  // === Processar mídias ===
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
        await fs.unlink(filePath).catch(() => {});
        await fs.unlink(mp3Path).catch(() => {});
      } else if (origin === 'document' || origin === 'image') {
        const fileText = await extractAnyText(filePath, mimetype);
        if (fileText) text = await summarizeDocument(fileText);
        await fs.unlink(filePath).catch(() => {});
      }
    } catch (err) {
      logger.error({ event: 'media.process.error', error: err.message });
      return sendMessage(from, "⚠️ Não consegui processar esse arquivo. Pode tentar novamente?");
    }
  }

  // === Lembretes ===
  const reminder = await extractReminder(text, from);
  if (reminder?.shouldRemind) {
    const scheduledAt = dayjs(`${reminder.date} ${reminder.time}`).tz(reminder.timezone, true);
    if (scheduledAt.isValid() && scheduledAt.isAfter(dayjs())) {
      const alert = await generateReminderAlert(reminder.content);
      const reminderObj = { from, ...reminder, scheduledAt: scheduledAt.toISOString() };
      await scheduleReminder(reminderObj, async (to, content) => {
        await sendMessage(to, content);
      });
      return sendMessage(from, `✅ Lembrete criado com sucesso!\n⏰ Está agendado para ${scheduledAt.format('DD/MM/YYYY [às] HH:mm')}.`, {
        buttons: [
          { buttonId: 'novo', buttonText: { displayText: '➕ Novo lembrete' }, type: 1 },
          { buttonId: 'listar', buttonText: { displayText: '📋 Ver lembretes' }, type: 1 }
        ],
        headerType: 1
      });
    } else {
      return sendMessage(from, "⚠️ Não consegui agendar o lembrete. Verifique se a data e a hora estão corretas.");
    }
  }

  // === Chat normal ===
  try {
    const reply = await chatResponse(text, from);
    await sendMessage(from, reply);
  } catch (err) {
    logger.error({ event: 'chat.error', from, error: err.message });
    await sendMessage(from, "❌ Ocorreu um erro ao tentar responder. Pode repetir sua pergunta?");
  }
}

async function startBot() {
  logger.info('🚀 Inicializando bot de lembretes no WhatsApp...');
  await ensureTempDir();
  const { state } = await useMultiFileAuthState('auth_info_baileys');
  sock = makeWASocket({ auth: state });

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
        logger.warn({ event: 'connection.closed', reconnect: shouldReconnect });
        if (shouldReconnect) startBot();
      } else if (connection === 'open') {
        logger.info('✅ Conectado ao WhatsApp!');
        console.log("🤖 Bot pronto para receber mensagens!");
      }
    }

    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages) {
        if (msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        try {
          await handleMessage(msg);
        } catch (err) {
          logger.error({ event: 'message.handler.error', from, error: err.message });
          sendMessage(from, "❌ Ocorreu um erro inesperado ao processar sua mensagem. Pode tentar novamente?");
        }
      }
    }
  });
}

module.exports = { startBot, sendMessage };
