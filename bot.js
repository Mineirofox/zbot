const { DisconnectReason, makeWASocket, useMultiFileAuthState, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { extractReminder, chatResponse, transcribeAudio, generateReminderAlert, webSearch, analyzeImage, summarizeDocument, extractAnyText } = require('./openai');
const { scheduleReminder, getUserReminders, clearUserReminders } = require('./scheduler');
const { appendToContext } = require('./contextManager');
const logger = require('./logger');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const os = require('os');

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

async function sendMessage(jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    await appendToContext(jid, 'assistant', text, 'notice');
    logger.info({ event: 'whatsapp.sent', to: jid, message: text });
  } catch (error) {
    logger.error({ event: 'whatsapp.send.failed', to: jid, error: error.message });
  }
}

async function downloadMedia(message, type, jid) {
  logger.info({ event: 'media.download.start', from: jid, type });
  const stream = await downloadContentFromMessage(message, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  logger.info({ event: 'media.download.success', from: jid, size: buffer.length });
  return buffer;
}

async function opusToMp3(opusBuffer) {
  await ensureTempDir();
  const inputPath = path.join(TEMP_DIR, `audio-${Date.now()}.opus`);
  const outputPath = path.join(TEMP_DIR, `audio-${Date.now()}.mp3`);

  return new Promise((resolve, reject) => {
    fssync.writeFile(inputPath, opusBuffer, (err) => {
      if (err) {
        return reject(new Error(`Failed to write opus file: ${err.message}`));
      }
      
      ffmpeg(inputPath)
        .output(outputPath)
        .audioCodec('libmp3lame')
        .on('end', async () => {
          await fs.unlink(inputPath).catch(() => {});
          resolve(outputPath);
        })
        .on('error', async (err) => {
          await fs.unlink(inputPath).catch(() => {});
          await fs.unlink(outputPath).catch(() => {});
          reject(new Error(`FFmpeg failed: ${err.message}`));
        })
        .run();
    });
  });
}

async function processMessage(message, from) {
  logger.info({ event: 'message.received', from });

  const now = dayjs().tz('America/Sao_Paulo');
  let text = '';
  let origin = 'text';

  // Texto normal
  if (message.conversation || message.extendedTextMessage?.text) {
    text = (message.conversation || message.extendedTextMessage.text).trim();
    origin = 'text';
    if (!text) return;
  }

  // Áudio
  else if (message.audioMessage) {
    logger.info({ event: 'audio.received', from, seconds: message.audioMessage.seconds });
    await sock.sendPresenceUpdate('composing', from);
    let mp3Path = null;
    try {
      const buffer = await downloadMedia(message.audioMessage, 'audio', from);
      mp3Path = await opusToMp3(buffer);
      const transcription = await transcribeAudio(mp3Path);
      if (!transcription) {
        await sendMessage(from, "Não entendi seu áudio. Pode repetir?");
        return;
      }
      text = transcription;
      origin = 'audio';
    } catch (err) {
      logger.error({ event: 'audio.process.failed', error: err.message });
      await sendMessage(from, "Desculpe, não consegui transcrever seu áudio.");
      return;
    } finally {
      if (mp3Path) {
        await fs.unlink(mp3Path).catch(() => {});
      }
    }
  }

  // Imagem
  else if (message.imageMessage) {
    logger.info({ event: 'image.received', from });
    await sock.sendPresenceUpdate('composing', from);
    const imagePath = path.join(TEMP_DIR, `img-${Date.now()}.jpg`);
    try {
      const buffer = await downloadMedia(message.imageMessage, 'image', from);
      await fs.writeFile(imagePath, buffer);
      const description = await analyzeImage(imagePath);
      text = description;
      origin = 'image';
      await sendMessage(from, text);
    } catch (err) {
      logger.error({ event: 'image.process.failed', error: err.message });
      await sendMessage(from, "Não consegui analisar sua imagem. 😥");
      return;
    } finally {
      await fs.unlink(imagePath).catch(() => {});
    }
  }

  // Documento (PDF, Office, HTML, etc)
  else if (message.documentMessage) {
    logger.info({ event: 'document.received', from, mimetype: message.documentMessage.mimetype });
    await sock.sendPresenceUpdate('composing', from);
    const docPath = path.join(TEMP_DIR, `doc-${Date.now()}`);
    try {
      const buffer = await downloadMedia(message.documentMessage, 'document', from);
      await fs.writeFile(docPath, buffer);

      const rawText = await extractAnyText(docPath, message.documentMessage.mimetype);

      if (!rawText.trim()) {
        await sendMessage(from, "📄 Não consegui extrair conteúdo legível desse arquivo.");
        return;
      }

      const summary = await summarizeDocument(rawText.slice(0, 4000));
      const summaryTextForLog = `[Documento resumido] ${summary}`;
      origin = 'document';

      // Salva no contexto o texto sem a tag
      await appendToContext(from, "user", summary, "document");
      await appendToContext(from, "user", rawText.slice(0, 10000), "doc_raw");

      // Envia a resposta com a tag
      await sendMessage(from, summaryTextForLog);
      
      logger.info({ event: 'document.summarized', text: summaryTextForLog });
    } catch (err) {
      logger.error({ event: 'document.process.failed', error: err.message });
      await sendMessage(from, "Erro ao processar o documento.");
      return;
    } finally {
      await fs.unlink(docPath).catch(() => {});
    }
  }

  else {
    return;
  }

  // === Salvar no contexto e Logar ===
  if (origin !== 'document' && origin !== 'image') { // Documento e imagem já lidam com isso
    const loggableText = (origin === 'audio')
      ? `[Áudio processado] ${text}`
      : text;
    
    await appendToContext(from, 'user', text, origin);
    logger.info({ event: `${origin}.processed`, text: loggableText });
  }

  // === Fluxo principal ===
  
  if (/(listar|meus) lembretes/i.test(text)) {
    const reminders = await getUserReminders(from);
    if (reminders.length === 0) {
      await sendMessage(from, "Você não tem lembretes ativos.");
    } else {
      const list = reminders.map((r, i) =>
        `📌 ${i + 1}. ${r.content} - ${dayjs(r.scheduledAt).tz('America/Sao_Paulo').format("DD/MM [às] HH:mm")}`
      ).join("\n");
      await sendMessage(from, `📋 Seus lembretes:\n${list}`);
    }
    return;
  }

  if (/(apagar|remover|excluir) (meus |os |todos os |)lembretes/i.test(text)) {
    await clearUserReminders(from);
    await sendMessage(from, "🗑️ Seus lembretes foram apagados.");
    return;
  }

  if (/^pesquisar (.+)$/i.test(text)) {
    const query = text.match(/^pesquisar (.+)$/i)[1];
    const result = await webSearch(query);
    await sendMessage(from, `🔎 Resultado da pesquisa:\n${result}`);
    return;
  }

  const parsed = await extractReminder(text, now);
  if (parsed.shouldRemind) {
    if (parsed.date && parsed.time) {
      const alert = await generateReminderAlert(parsed.content);
      const reminder = {
        from: from,
        content: parsed.content,
        date: parsed.date,
        time: parsed.time,
        timezone: parsed.timezone || 'America/Sao_Paulo',
      };
      await scheduleReminder(reminder, () => sendMessage(from, alert));
      const scheduledTime = dayjs.tz(`${parsed.date} ${parsed.time}`, 'YYYY-MM-DD HH:mm', parsed.timezone || 'America/Sao_Paulo');
      await sendMessage(from, `✅ Agendei seu lembrete: *${parsed.content}* em ${scheduledTime.format("DD/MM [às] HH:mm")}`);
      return;
    }
  }

  // Chat normal
  const reply = await chatResponse(text, from);
  await sendMessage(from, reply);
}

async function startBot() {
  logger.info('🚀 Inicializando bot de lembretes no WhatsApp...');
  await ensureTempDir();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
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
        const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.warn({ event: 'connection.closed', reconnect: shouldReconnect });
        if (shouldReconnect) startBot();
      } else if (connection === 'open') {
        logger.info('✅ Conectado ao WhatsApp!');
      }
    }

    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages) {
        if (msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        await processMessage(msg.message, from);
      }
    }

    if (events['creds.update']) {
      await saveCreds();
    }
  });
}

module.exports = { startBot, sendMessage };