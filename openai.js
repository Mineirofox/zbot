const { OpenAI } = require("openai");
const config = require("./config");
const logger = require("./logger");
const fs = require("fs");
const fssync = require("fs");
const pdfParse = require("pdf-parse");
const mime = require("mime-types");
const { getContext } = require("./contextManager");

// libs para Office / formatos extras
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const unzipper = require("unzipper");
const xml2js = require("xml2js");

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

// --- Chat normal com histórico ---
const chatPrompt = `
Você é um assistente pessoal brasileiro, empático e natural.
- Nunca diga que é IA.
- Responda como um amigo próximo.
- Use contexto da conversa (inclusive descrições de imagens ou documentos).
- Máx 3 frases.
- Emojis moderados.
`;

async function chatResponse(text, jid) {
  try {
    const history = await getContext(jid);

    const messages = [
      { role: "system", content: chatPrompt },
      ...history.map((h) => ({
        role: h.role === "assistant" ? "assistant" : "user",
        content: h.content
      })),
      { role: "user", content: text }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      max_tokens: 300,
      temperature: 0.8,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    logger.error({ event: "openai.chatResponse.error", error: error.message });
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

// --- Análise de imagem (via GPT-4o com visão) ---
async function analyzeImage(filePath) {
  try {
    const fileB64 = fs.readFileSync(filePath).toString("base64");
    const type = mime.lookup(filePath) || "image/jpeg";
    const dataUrl = `data:${type};base64,${fileB64}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Descreva esta imagem de forma clara em português." },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    logger.error({ event: "openai.analyzeImage.error", error: err.message });
    return "Não consegui analisar a imagem.";
  }
}

// --- Resumo de documentos ---
async function summarizeDocument(text) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: `Resuma em português o seguinte documento:\n\n${text}`,
        },
      ],
      max_tokens: 300,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    logger.error({ event: "openai.summarizeDocument.error", error: error.message });
    return "Não consegui resumir o documento.";
  }
}

// --- Extrair texto de PDF ---
async function extractPdfText(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    logger.error({ event: "openai.extractPdfText.error", error: error.message });
    return "";
  }
}

// --- Extrair texto de PPTX (novo) ---
async function parsePptx(filePath) {
  try {
    const slides = [];
    const directory = await unzipper.Open.file(filePath);

    for (const entry of directory.files) {
      if (entry.path.startsWith("ppt/slides/slide") && entry.path.endsWith(".xml")) {
        const content = await entry.buffer();
        const xml = content.toString();
        const parsed = await xml2js.parseStringPromise(xml);

        const texts = [];
        function collect(node) {
          if (!node) return;
          if (Array.isArray(node)) node.forEach(collect);
          else if (typeof node === "object") {
            if (node["a:t"]) texts.push(...node["a:t"]);
            Object.values(node).forEach(collect);
          }
        }
        collect(parsed);

        slides.push(texts.join(" "));
      }
    }

    return slides.join("\n---\n");
  } catch (err) {
    logger.error({ event: "openai.parsePptx.error", error: err.message });
    return "";
  }
}

// --- NOVA FUNÇÃO: Extrair texto de qualquer arquivo ---
async function extractAnyText(filePath, mimetype) {
  try {
    // PDF
    if (mimetype === "application/pdf") {
      return await extractPdfText(filePath);
    }

    // DOCX
    if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || "";
    }

    // PPTX
    if (mimetype === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      return await parsePptx(filePath);
    }

    // XLSX
    if (mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      const workbook = xlsx.readFile(filePath);
      let text = "";
      workbook.SheetNames.forEach(name => {
        const sheet = workbook.Sheets[name];
        text += xlsx.utils.sheet_to_csv(sheet) + "\n";
      });
      return text;
    }

    // Outros arquivos de texto (txt, html, js, md, json etc)
    if (
      mimetype.startsWith("text/") ||
      mimetype === "application/javascript" ||
      mimetype === "application/json" ||
      mimetype === "text/html" ||
      mimetype === "text/markdown"
    ) {
      return fssync.readFileSync(filePath, "utf-8");
    }

    return "";
  } catch (err) {
    logger.error({ event: "openai.extractAnyText.error", error: err.message });
    return "";
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
  analyzeImage,
  summarizeDocument,
  extractPdfText,
  extractAnyText,
};