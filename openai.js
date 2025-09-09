const { OpenAI } = require("openai");
const config = require("./config");
const logger = require("./logger");
const fssync = require("fs");
const pdfParse = require("pdf-parse");
const { getContext } = require("./contextManager");

const mammoth = require("mammoth");
const xlsx = require("xlsx");
const { getLinkPreview } = require("link-preview-js");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezonePlugin = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const poe = new OpenAI({
  apiKey: config.POE_API_KEY,
  baseURL: "https://api.poe.com/v1",
});

// --- Função auxiliar para limpar, numerar e enriquecer links ---
async function formatLinks(content) {
  if (!content) return "";

  let cleanContent = content;

  // Corrigir casos estranhos tipo [[1]](url) -> [1]
  cleanContent = cleanContent.replace(/\[\[(\d+)\]\]\([^)]+\)/g, "[$1]");
  cleanContent = cleanContent.replace(/\(\((\d+)\)\)/g, "[$1]");
  cleanContent = cleanContent.replace(/\[\[(\d+)\]\]\(\(\d+\)\)/g, "[$1]");

  const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s]+)/gi;
  let index = 0;
  const links = [];
  const seen = new Set();

  const textWithRefs = cleanContent.replace(urlRegex, (match, label, url, rawUrl) => {
    const finalUrl = url || rawUrl;
    if (!finalUrl) return match;

    if (!seen.has(finalUrl)) {
      index++;
      seen.add(finalUrl);
      links.push({ index, url: finalUrl, label: label || null });
    }

    const refIndex = Array.from(seen).indexOf(finalUrl) + 1;
    if (label) {
      return `${label} [${refIndex}]`;
    } else {
      return `[${refIndex}]`;
    }
  });

  if (links.length > 0) {
    let fontes = "\n\nFontes:";

    if (config.LINK_PREVIEWS_ENABLED) {
      // Enriquecer links com preview (quando possível)
      const previews = await Promise.all(
        links.map(async ({ index, url }) => {
          try {
            const data = await getLinkPreview(url, { followRedirects: "follow", timeout: 5000 });
            const title = data.title || url;
            const description = data.description ? ` - ${data.description}` : "";
            return `[${index}] ${title}${description}\n${url}`;
          } catch {
            return `[${index}] ${url}`;
          }
        })
      );

      return textWithRefs.trim() + fontes + "\n" + previews.join("\n\n");
    } else {
      // Apenas lista simples de links
      const simpleList = links.map(l => `[${l.index}] ${l.url}`);
      return textWithRefs.trim() + fontes + "\n" + simpleList.join("\n");
    }
  }

  return textWithRefs;
}

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
  "timezone": "America/Sao_Paulo",
  "content": "conteúdo do lembrete" | null
}
`;
}

// --- Funções de IA ---
async function extractReminder(text, jid) {
  logger.info({ event: "openai.extractReminder.start" });
  const messages = [
    { role: "system", content: getReminderPrompt(dayjs().tz(config.DEFAULT_TIMEZONE)) },
    { role: "user", content: text || "" },
  ];

  try {
    const safeMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content || ""),
    }));

    const completion = await poe.chat.completions.create({
      model: "Gemini-2.0-Flash",
      messages: safeMessages,
      max_tokens: 1024,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const rawResponse = completion.choices?.[0]?.message?.content || "";
    if (!rawResponse) return null;

    const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    logger.error({ event: "poe.extractReminder.error", error: error.message, text });
    return null;
  }
}

async function chatResponse(text, jid) {
  logger.info({ event: "poe.chatResponse.start" });
  try {
    const messages = await getContext(jid, text);
    const safeMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content || ""),
    }));

    const completion = await poe.chat.completions.create({
      model: "Gemini-2.0-Flash",
      messages: safeMessages,
      max_tokens: 1024,
      temperature: 0.8,
    });

    const rawContent = completion.choices?.[0]?.message?.content?.trim() || "Não consegui gerar uma resposta.";
    return await formatLinks(rawContent);

  } catch (error) {
    logger.error({ event: "poe.chatResponse.error", error: error.message });
    return "Ocorreu um erro ao gerar a resposta. Por favor, tente novamente.";
  }
}

async function transcribeAudio(filePath) {
  logger.info({ event: "openai.transcribeAudio.start" });
  try {
    const transcript = await openai.audio.transcriptions.create({
      file: fssync.createReadStream(filePath),
      model: "whisper-1",
    });
    return transcript.text;
  } catch (error) {
    logger.error({ event: "openai.transcribeAudio.error", error: error.message });
    return `Ocorreu um erro ao transcrever o áudio: ${error.message}`;
  }
}

async function generateReminderAlert(reminderContent) {
  logger.info({ event: "poe.generateReminderAlert.start" });
  const messages = [
    {
      role: "system",
      content: `Você é um assistente simpático e pontual que envia lembretes.
      Inclua um emoji de lembrete (⏰).`,
    },
    { role: "user", content: `A frase do lembrete é: "${reminderContent}"` },
  ];
  try {
    const safeMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content || ""),
    }));

    const completion = await poe.chat.completions.create({
      model: "Gemini-2.0-Flash",
      messages: safeMessages,
      max_tokens: 1024,
      temperature: 0.8,
    });

    const rawContent = completion.choices?.[0]?.message?.content?.trim();
    return rawContent ? await formatLinks(rawContent) : `⏰ Lembrete: ${reminderContent}`;
  } catch (error) {
    logger.error({ event: "poe.generateReminderAlert.error", error: error.message });
    return `⏰ Lembrete: ${reminderContent}`;
  }
}

async function webSearch(query) {
  logger.info({ event: "poe.webSearch.start", query });
  try {
    const chat = await poe.chat.completions.create({
      model: "Web-Search",
      messages: [{ role: "user", content: String(query || "") }],
    });

    const rawContent = chat.choices?.[0]?.message?.content?.trim() || "Nenhum resultado retornado.";
    return await formatLinks(rawContent);

  } catch (error) {
    logger.error({ event: "poe.webSearch.error", error: error.message });
    return `Ocorreu um erro ao realizar a busca na web: ${error.message}`;
  }
}

async function summarizeDocument(text) {
  logger.info({ event: "poe.summarizeDocument.start" });
  const messages = [
    {
      role: "system",
      content: `Você é um assistente de resumo de documentos. Responda em português.`,
    },
    { role: "user", content: `Por favor, resuma o seguinte texto:\n\n${text || ""}` },
  ];
  try {
    const safeMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content || ""),
    }));

    const completion = await poe.chat.completions.create({
      model: "Gemini-2.0-Flash",
      messages: safeMessages,
      max_tokens: 1024,
      temperature: 0.5,
    });

    const rawContent = completion.choices?.[0]?.message?.content?.trim() || "Resumo não disponível.";
    return await formatLinks(rawContent);

  } catch (error) {
    logger.error({ event: "poe.summarizeDocument.error", error: error.message });
    return "Não foi possível gerar um resumo para este documento.";
  }
}

async function extractAnyText(filePath, mimetype) {
  try {
    if (mimetype === "application/pdf") {
      const dataBuffer = fssync.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    }

    if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    if (mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      const workbook = xlsx.readFile(filePath);
      let text = "";
      workbook.SheetNames.forEach(name => {
        const sheet = workbook.Sheets[name];
        text += xlsx.utils.sheet_to_csv(sheet) + "\n";
      });
      return text;
    }

    if (
      mimetype.startsWith("text/") ||
      ["application/javascript", "application/json", "text/html", "text/markdown"].includes(mimetype)
    ) {
      return fssync.readFileSync(filePath, "utf-8");
    }

    return "";
  } catch (err) {
    logger.error({ event: "openai.extractAnyText.error", error: err.message });
    return "";
  }
}

module.exports = {
  extractReminder,
  chatResponse,
  transcribeAudio,
  generateReminderAlert,
  webSearch,
  summarizeDocument,
  extractAnyText,
};
