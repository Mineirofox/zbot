const baileys = require('@whiskeysockets/baileys');
const {
  DisconnectReason,
  makeWASocket,
  downloadContentFromMessage
} = baileys;

const {
  extractReminder,
  extractForwardMessage,
  chatResponse,
  transcribeAudio,
  generateReminderAlert,
  summarizeDocument,
  extractAnyText
} = require('./openai');
const { scheduleReminder, getUserReminders, clearUserReminders, saveReminders, loadReminders } = require('./scheduler');
const { appendToContext } = require('./contextManager');
const { setContact, getContact, listContacts, removeContact } = require('./contactsManager');
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

// 🔥 Helper para efeito de digitando
function startComposing(from) {
  sock.sendPresenceUpdate('composing', from).catch(() => {});
  return setInterval(() => {
    sock.sendPresenceUpdate('composing', from).catch(() => {});
  }, 4000);
}
async function stopComposing(interval, from) {
  clearInterval(interval);
  await sock.sendPresenceUpdate('paused', from).catch(() => {});
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

    // === CONTATOS ===
    if (text.toLowerCase().startsWith("!estabelecer")) {
      const match = text.match(/!estabelecer\s+(\d+)\s+como\s+(.+)/i);
      if (!match) {
        return sendMessage(from, "❌ Uso incorreto. Exemplo: *!estabelecer 33999999999 como Fulano*");
      }
      const [, number, alias] = match;
      await setContact(alias, number + "@s.whatsapp.net");
      return sendMessage(from, `✅ Contato salvo: *${alias}* → ${number}`);
    }

    if (text.toLowerCase() === "!contatos") {
      const contacts = await listContacts();
      if (Object.keys(contacts).length === 0) {
        return sendMessage(from, "📭 Nenhum contato salvo.");
      }
      const list = Object.entries(contacts)
        .map(([alias, jid], i) => `#️⃣ ${i + 1} → *${alias}* (${jid.replace("@s.whatsapp.net","")})`)
        .join("\n");
      return sendMessage(from, "📇 *Contatos salvos:*\n" + list);
    }

    if (text.toLowerCase().startsWith("!remover-contato")) {
      const parts = text.split(" ");
      if (parts.length < 2) {
        return sendMessage(from, "❌ Exemplo: *!remover-contato Fulano*");
      }
      const alias = parts.slice(1).join(" ");
      await removeContact(alias);
      return sendMessage(from, `🗑️ Contato *${alias}* removido.`);
    }

    // === LISTAR LEMBRETES ===
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
      const all = await loadReminders();
      const left = all.filter(r => r.id !== toDelete.id);
      await saveReminders(left);

      logger.infoWithContext('reminder.deleted', { from, deleted: toDelete.content });
      return sendMessage(from, `🗑️ Lembrete removido: *${toDelete.content}*`);
    }

    // === lembretes automáticos ===
    const reminder = await extractReminder(text, from);
    const isReminderLike = /\b(me\s+lembre|me\s+lembrar|me\s+notifique|me\s+avise)\b/i.test(text);

    if (reminder?.shouldRemind && isReminderLike) {
      const scheduledAt = dayjs(`${reminder.date} ${reminder.time}`).tz(reminder.timezone, true);
      if (scheduledAt.isValid() && scheduledAt.isAfter(dayjs())) {
        const alert = await generateReminderAlert(reminder.content);
        const reminderObj = { from, ...reminder, scheduledAt: scheduledAt.toISOString() };
        await scheduleReminder(reminderObj, async (to, content) => {
          await sendMessage(to, content);
        });
        logger.infoWithContext('reminder.scheduled', { from, at: scheduledAt.toString(), content: reminder.content });
        return sendMessage(from, `✅ *Lembrete criado!* ⏰\n${scheduledAt.format('DD/MM/YYYY [às] HH:mm')}`);
      } else {
        logger.warnWithContext('reminder.invalid', { from, reminder });
        return sendMessage(from, "⚠️ Não consegui agendar o lembrete. Verifique a data/hora.");
      }
    }

    // === envio de mensagem para outro contato ===
    const fwd = await extractForwardMessage(text, from);
    if (fwd?.shouldSend) {
      let contactJid = await getContact(fwd.recipient);
      if (!contactJid) {
        return sendMessage(from, `❌ Contato *${fwd.recipient}* não encontrado. Cadastre com: *!estabelecer <número> como ${fwd.recipient}*`);
      }

      const scheduledAt = dayjs(`${fwd.date} ${fwd.time}`).tz(fwd.timezone, true);
      if (!scheduledAt.isValid() || !scheduledAt.isAfter(dayjs())) {
        return sendMessage(from, "⚠️ Data/hora inválida para envio.");
      }

      // === identificar apelido do remetente ===
      let aliasFrom = null;
      const allContacts = await listContacts();
      for (const [nickname, jid] of Object.entries(allContacts)) {
        if (jid === from) {
          aliasFrom = nickname;
          break;
        }
      }
      if (!aliasFrom) {
        aliasFrom = from.replace(/@s\.whatsapp\.net$/, "");
      }

      const reminderObj = {
        from: from,
        recipient: contactJid,
        content: fwd.content,
        fromAlias: aliasFrom,
        date: fwd.date,
        time: fwd.time,
        timezone: fwd.timezone,
      };

      await scheduleReminder(
        reminderObj,
        async (targetJid, content) => {
          await sendMessage(targetJid, content);
        },
        async (creatorJid, sentReminder) => {
          await sendMessage(creatorJid, `✅ Sua mensagem para ${fwd.recipient} foi entregue.`);
        }
      );

      return sendMessage(from, `📩 *Mensagem agendada para ${fwd.recipient}!* ⏰\n${scheduledAt.format('DD/MM/YYYY [às] HH:mm')}`);
    }

    // === processamento de mídias ===
    if (origin !== 'text' && msg.message[origin + "Message"]) {
      const mediaPath = path.join(TEMP_DIR, `media-${msg.key.id}`);
      const mimetype = msg.message[origin + "Message"].mimetype;
      const extension = mime.extension(mimetype) || 'bin';
      const filePath = `${mediaPath}.${extension}`;

      const stream = await downloadContentFromMessage(msg.message[origin + "Message"], origin);
      const writable = require("fs").createWriteStream(filePath);

      for await (const chunk of stream) {
        writable.write(chunk);
      }
      writable.end();

      const composingInterval = startComposing(from);
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
        await stopComposing(composingInterval, from);
        logger.errorWithContext('media.process.error', err);
        return sendMessage(from, "⚠️ Não consegui processar esse arquivo. Pode tentar novamente?");
      }
      await stopComposing(composingInterval, from);
    }

    // === resposta normal ===
    try {
      logger.infoWithContext('chatResponse.start', { from });
      const composingInterval = startComposing(from);

      const reply = await chatResponse(text, from);

      await stopComposing(composingInterval, from);

      if (reply && reply.trim()) {
        await sendMessage(from, reply);
      }
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