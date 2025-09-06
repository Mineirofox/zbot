// openai.js
const { OpenAI } = require('openai');
const config = require('./config');
const logger = require('./logger');
const fs = require('fs');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// --- Prompt com data/hora atual fornecida ---
function getReminderPrompt(currentDateTime) {
  return `
Você é um especialista em extrair lembretes de mensagens informais em português do Brasil.

Data e hora atuais do sistema: ${currentDateTime.format('dddd, DD [de] MMMM [de] YYYY [às] HH:mm:ss')} (fuso: America/Sao_Paulo)

Analise a mensagem e responda APENAS em JSON:
{
  "shouldRemind": boolean,
  "date": "YYYY-MM-DD" | null,
  "time": "HH:mm" | null,
  "timezone": "string" | null,
  "content": "string" | null
}

Regras:
- shouldRemind = true apenas se houver intenção clara: "me lembre", "não esqueça", "avise", etc.
- Use a data/hora atual acima para calcular relativas: "em 1 minuto", "daqui a 3 horas", "amanhã"
- Converta tudo para valores absolutos (ex: se agora é 23:45, "em 1 minuto" → 23:46 do mesmo dia)
- "meio dia" = "12:00", "meia-noite" = "00:00"
- Fuso padrão: America/Sao_Paulo
- content = ação: "comer pizza", "ligar pro médico"
- Nunca invente. Se não souber, deixe null.
`;
}

async function extractReminder(text, currentDateTime) {
  logger.debug({ event: 'openai.extractReminder.start', message: text, currentDateTime: currentDateTime.format() });
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: getReminderPrompt(currentDateTime) },
        { role: 'user', content: text }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });
    const result = JSON.parse(completion.choices[0].message.content);
    logger.info({ event: 'openai.extractReminder.success', message: text, result });
    return result;
  } catch (error) {
    logger.error({ event: 'openai.extractReminder.error', message: text, error: error.message });
    return { shouldRemind: false };
  }
}

// --- Resposta natural no chat ---
const chatPrompt = `
Você é um assistente pessoal brasileiro, empático e natural.
- Nunca diga que é IA.
- Responda com empatia, como um amigo.
- Use no máximo 2 frases.
- Pode usar emojis com moderação.
- Se disser "oi", responda com "Ei! Tudo bem? Como posso te ajudar? 😊"
`;

async function chatResponse(text, jid) {
  logger.debug({ event: 'openai.chatResponse.start', jid, message: text });
  try {
    const context = await require('./contextManager').loadContext(jid);
    const messages = [
      { role: 'system', content: chatPrompt },
      ...context,
      { role: 'user', content: text }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 150,
      temperature: 0.8
    });

    const reply = completion.choices[0].message.content.trim();
    logger.info({ event: 'openai.chatResponse.success', jid, reply });
    return reply;
  } catch (error) {
    logger.error({ event: 'openai.chatResponse.error', jid, error: error.message });
    return "Deu um probleminha... Mas tô aqui, pode repetir?";
  }
}

// --- Gera aviso humanizado no horário do lembrete ---
async function generateReminderAlert(content, jid) {
  const prompt = `
Gere um aviso natural e empático para lembrar alguém de: "${content}"
- Seja gentil, como um amigo lembrando com carinho
- Use no máximo 1 frase
- Pode usar emojis
- Nunca diga "Lembrete:"
- Ex: "Ei, amor, não esquece de tomar água! 💧"
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
      temperature: 0.9
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    return `⏰ ${content}`;
  }
}

// --- Transcrição de áudio ---
async function transcribeAudio(filePath) {
  logger.info({ event: 'audio.transcribe.start', file: filePath });
  try {
    const fileStream = fs.createReadStream(filePath);
    const transcription = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: 'pt'
    });
    logger.info({ event: 'audio.transcribe.success', text: transcription.text });
    return transcription.text.trim();
  } catch (error) {
    logger.error({ event: 'audio.transcribe.error', error: error.message });
    throw new Error('Falha na transcrição: ' + error.message);
  }
}

module.exports = { extractReminder, chatResponse, transcribeAudio, generateReminderAlert };