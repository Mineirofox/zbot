// bot.js
const { DisconnectReason, makeWASocket, useMultiFileAuthState, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { extractReminder, chatResponse, transcribeAudio, generateReminderAlert, webSearch } = require('./openai');
const { scheduleReminder, getUserReminders, clearUserReminders } = require('./scheduler');
const { appendToContext } = require('./contextManager');
const logger = require('./logger');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// ┌─────────────────────────────┐
// │  CONFIGURAÇÃO DO DAYJS (TOP) │
// └─────────────────────────────┘
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezonePlugin = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezonePlugin);
// └─────────────────────────────┘

ffmpeg.setFfmpegPath(ffmpegStatic);

// ✅ Agora usa diretório temporário do SO
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
    await appendToContext(jid, 'assistant', text);
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
  await fs.writeFile(inputPath, opusBuffer);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .output(outputPath)
      .audioCodec('libmp3lame')
      .on('end', async () => {
        await fs.unlink(inputPath).catch(console.warn);
        resolve(outputPath);
      })
      .on('error', async (err) => {
        await fs.unlink(inputPath).catch(console.warn);
        await fs.unlink(outputPath).catch(console.warn);
        reject(err);
      })
      .run();
  });
}

async function processMessage(message, from) {
  logger.info({ event: 'message.received', from });

  const now = dayjs().tz('America/Sao_Paulo');
  let text = '';

  if (message.conversation || message.extendedTextMessage?.text) {
    text = (message.conversation || message.extendedTextMessage.text).trim();
    if (!text) return;
  }
  else if (message.audioMessage) {
    logger.info({ event: 'audio.received', from, seconds: message.audioMessage.seconds });
    try {
      const buffer = await downloadMedia(message.audioMessage, 'audio', from);
      const mp3Path = await opusToMp3(buffer);
      const transcription = await transcribeAudio(mp3Path);
      await fs.unlink(mp3Path);
      if (!transcription) {
        await sendMessage(from, "Não entendi seu áudio. Pode repetir?");
        return;
      }
      text = transcription;
      logger.info({ event: 'audio.transcribed', text });
    } catch (err) {
      logger.error({ event: 'audio.process.failed', error: err.message });
      await sendMessage(from, "Desculpe, não consegui processar seu áudio agora.");
      return;
    }
  } else {
    return;
  }

  await appendToContext(from, 'user', text);

  // Normaliza o texto (remove acentos, deixa minúsculo)
  const cleanText = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // ✅ Comando: Pesquisa na Web
  if (
    cleanText.startsWith('pesquisa na internet') ||
    cleanText.startsWith('pesquise na internet') ||
    cleanText.startsWith('faça uma busca na internet') ||
    cleanText.startsWith('faca uma busca na internet') ||
    cleanText.startsWith('pesquise na web') ||
    cleanText.startsWith('busca na web') ||
    cleanText.startsWith('buscar na internet')
  ) {
    logger.info({ event: 'command.web-search', from, text });

    const query = text.replace(
      /^(pesquisa na internet|pesquise na internet|faça uma busca na internet|faca uma busca na internet|pesquise na web|busca na web|buscar na internet)\s*/i,
      ''
    );
    if (!query) {
      await sendMessage(from, "O que você deseja que eu pesquise na web? 🌐");
      return;
    }

    const result = await webSearch(query);
    await sendMessage(from, `🔎 Resultado da pesquisa:\n\n${result}`);
    return;
  }

  // ✅ Comando: Apagar todos os lembretes
  if (
    cleanText.includes('apagar lembretes') ||
    cleanText.includes('deletar lembretes') ||
    cleanText.includes('remover lembretes') ||
    cleanText.includes('limpar lista de lembretes') ||
    cleanText.includes('apagar meus lembretes') ||
    cleanText.includes('excluir todos os lembretes')
  ) {
    logger.info({ event: 'command.clear-reminders', from });

    const activeReminders = await getUserReminders(from);

    if (activeReminders.length === 0) {
      await sendMessage(from, "📭 Você não tem lembretes para apagar. Tudo limpo! 🧹");
      return;
    }

    await clearUserReminders(from);

    const msg = [
      "🧹 Todos os seus lembretes foram apagados com sucesso!",
      "Se precisar marcar outros, é só pedir. Estou por aqui! 😊"
    ].join('\n\n');
    await sendMessage(from, msg);
    return;
  }

  // ✅ Comando: Listar lembretes
  if (
    cleanText.includes('listar lembretes') ||
    cleanText.includes('mostrar lembretes') ||
    cleanText.includes('mostrar agendamentos') ||
    cleanText.includes('lembretes ativos') ||
    cleanText.includes('quais lembretes') ||
    cleanText.includes('meus lembretes') ||
    cleanText.includes('ver lembretes')
  ) {
    logger.info({ event: 'command.list-reminders', from });

    const activeReminders = await getUserReminders(from);

    if (activeReminders.length === 0) {
      await sendMessage(from, "📭 Você não tem lembretes agendados no momento. Que tal marcar um? 😊");
      return;
    }

    let list = "📋 *Seus lembretes agendados:*\n\n";
    activeReminders.forEach((r, i) => {
      const scheduled = dayjs(r.scheduledAt);
      const diff = scheduled.diff(now, 'minutes');
      let when;

      if (diff < 1) when = "em instantes";
      else if (diff < 60) when = `em ${diff} minuto${diff > 1 ? 's' : ''}`;
      else if (diff < 1440) when = `em ${Math.floor(diff / 60)}h`;
      else when = `em ${Math.floor(diff / 1440)} dia${Math.floor(diff / 1440) > 1 ? 's' : ''}`;

      list += `📌 *${i + 1}. ${r.content}*\n`;
      list += `   📅 ${scheduled.format('DD/MM')} | ⏰ ${scheduled.format('HH:mm')} | ${when}\n\n`;
    });

    list += `✅ Total: ${activeReminders.length} lembrete${activeReminders.length > 1 ? 's' : ''}`;
    await sendMessage(from, list);
    return;
  }

  // ✅ Processa lembrete
  const reminderData = await extractReminder(text, now);

  if (reminderData.shouldRemind && reminderData.date && reminderData.time) {
    logger.info({ event: 'intent.reminder', from, reminderData });

    const timezone = reminderData.timezone || 'America/Sao_Paulo';
    const scheduledTime = dayjs.tz(`${reminderData.date} ${reminderData.time}`, timezone);

    if (scheduledTime.isBefore(now)) {
      await sendMessage(from, `⏰ Esse horário já passou! Quer agendar para daqui a pouco?`);
      return;
    }

    const content = reminderData.content || 'algo importante';

    const confirmation = `
✅ Beleza! Lembrete agendado!
📅 ${scheduledTime.format('DD/MM/YYYY')}
⏰ ${scheduledTime.format('HH:mm')} (${timezone.replace('_', ' ')})
💬 ${content}
Te aviso com carinho na hora! 💬`;
    await sendMessage(from, confirmation);

    await scheduleReminder(
      {
        from,
        date: reminderData.date,
        time: reminderData.time,
        timezone,
        content,
        timestamp: Date.now()
      },
      async (to, baseContent) => {
        const humanMsg = await generateReminderAlert(baseContent, to);
        await sendMessage(to, humanMsg);
      }
    );

    return;
  }

  if (reminderData.shouldRemind) {
    logger.warn({ event: 'reminder.incomplete', from, reminderData });
    await sendMessage(from, "Desculpe, não entendi bem quando você quer ser lembrado. Pode ser mais específico?");
    return;
  }

  logger.info({ event: 'intent.chat', from, message: text });
  const reply = await chatResponse(text, from);
  await sendMessage(from, reply);
}

async function startBot() {
  logger.info('🚀 Inicializando bot de lembretes no WhatsApp...');
  await ensureTempDir();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  sock = makeWASocket({
    auth: state
  });

  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update'];

      if (qr) {
        const qrcode = require('qrcode-terminal');
        console.log('┌─────────────────────────────┐');
        console.log('│      ESCANEIE O QR CODE     │');
        console.log('└─────────────────────────────┘');
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