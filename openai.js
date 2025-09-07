// openai.js
const { OpenAI } = require("openai");
const config = require("./config");
const logger = require("./logger");
const fs = require("fs");

// --- Cliente oficial OpenAI (para GPT e Whisper) ---
const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// --- Cliente Poe (para Web Search) ---
const poe = new OpenAI({
  apiKey: config.POE_API_KEY,
  baseURL: "https://api.poe.com/v1",
});

// --- Prompt de lembrete ---
function getReminderPrompt(currentDateTime) {
  return `
Você é um especialista em extrair lembretes de mensagens informais em português do Brasil.
Data e hora atuais: ${currentDateTime.format(
    "dddd, DD [de] MMMM [de] YYYY [às] HH:mm:ss"
  )} (fuso: America/Sao_Paulo)

Responda apenas em JSON:
{
  "shouldRemind": boolean,
  "date": "YYYY-MM-DD" | null,
  "time": "HH:mm" | null,
  "timezone": "string" | null,
  "content": "string" | null
}
`;
}

// --- Extrair lembrete ---
async function extractReminder(text, currentDateTime) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: getReminderPrompt(currentDateTime) },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    logger.error({ event: "openai.extractReminder.error", error: error.message });
    return { shouldRemind: false };
  }
}

// --- Chat normal ---
const chatPrompt = `
Você é um assistente pessoal brasileiro, empático e natural.
- Nunca diga que é IA.
- Responda como um amigo próximo.
- Máx 2 frases.
- Emojis moderados.
`;

async function chatResponse(text, jid) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: chatPrompt },
        { role: "user", content: text },
      ],
      max_tokens: 150,
      temperature: 0.8,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return "Deu um probleminha... pode repetir?";
  }
}

// --- Aviso humanizado de lembrete ---
async function generateReminderAlert(content) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: `Gere um aviso natural para lembrar: "${content}" em 1 frase curta e amigável.`,
        },
      ],
      temperature: 0.9,
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    return `⏰ ${content}`;
  }
}

// --- Transcrição de áudio ---
async function transcribeAudio(filePath) {
  try {
    const fileStream = fs.createReadStream(filePath);
    const transcription = await openai.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-1",
      language: "pt",
    });
    return transcription.text.trim();
  } catch (error) {
    throw new Error("Falha na transcrição: " + error.message);
  }
}

// --- Busca na web (via Poe Web-Search) ---
async function webSearch(query) {
  logger.info({ event: "poe.webSearch.start", query });

  try {
    const chat = await poe.chat.completions.create({
      model: "Web-Search",
      messages: [{ role: "user", content: query }],
    });

    return chat.choices[0].message.content.trim();
  } catch (error) {
    logger.error({ event: "poe.webSearch.error", error: error.message });
    return `⚠️ Erro na busca via Poe: ${error.message}`;
  }
}

module.exports = {
  extractReminder,
  chatResponse,
  transcribeAudio,
  generateReminderAlert,
  webSearch,
};