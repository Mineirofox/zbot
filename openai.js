// openai.js (ATUALIZADO - Gemini + limpeza de links com índices)
const { OpenAI } = require("openai");
const config = require("./config");
const logger = require("./logger");
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

const openai = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;
const poe = config.POE_API_KEY
  ? new OpenAI({ apiKey: config.POE_API_KEY, baseURL: "https://api.poe.com/v1" })
  : null;

/* -------------------
   helper: formatLinks
   ------------------- */
async function formatLinks(content) {
  if (!content) return "";

  let cleanContent = content;
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
    return label ? `${label} [${refIndex}]` : `[${refIndex}]`;
  });

  if (links.length > 0) {
    let fontes = "\n\nFontes:";
    if (config.LINK_PREVIEWS_ENABLED) {
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
      const simpleList = links.map(l => `[${l.index}] ${l.url}`);
      return textWithRefs.trim() + fontes + "\n" + simpleList.join("\n");
    }
  }
  return textWithRefs;
}

/* -------------------
   REMINDER PROMPTS
   ------------------- */
function getReminderPrompt(currentDateTime) {
  return `
Você é um especialista em extrair lembretes de mensagens informais em português do Brasil.

Data e hora atuais: ${currentDateTime.format(
    "dddd, DD [de] MMMM [de] YYYY [às] HH:mm:ss"
  )} (fuso: America/Sao_Paulo)

REGRAS IMPORTANTES:
- Sempre converta expressões relativas ("daqui a 5 minutos", "amanhã às 10") em uma DATA e HORA ABSOLUTAS.
- Preencha:
   - "date": no formato "YYYY-MM-DD"
   - "time": no formato "HH:mm"
- Se não houver referência de tempo clara, "shouldRemind" deve ser false.

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

async function extractReminder(text, jid) {
  if (!poe) {
    logger.warn("POE_API_KEY ausente, não é possível extrair lembretes.");
    return null;
  }
  logger.info({ event: "openai.extractReminder.start" });
  try {
    const completion = await poe.chat.completions.create({
      model: "Gemini-2.0-Flash",
      messages: [
        { role: "system", content: getReminderPrompt(dayjs().tz(config.DEFAULT_TIMEZONE)) },
        { role: "user", content: text || "" },
      ],
      max_tokens: 1024,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const rawResponse = completion.choices?.[0]?.message?.content || "";
    const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (err) {
    logger.error({ event: "poe.extractReminder.error", error: err.message, text });
    return null;
  }
}

/* -------------------
   FORWARD MESSAGE PROMPT
   ------------------- */
function getForwardMessagePrompt(currentDateTime) {
  return `
Você é um especialista em interpretar instruções para enviar mensagens para TERCEIROS.

Data e hora atuais: ${currentDateTime.format(
    "dddd, DD [de] MMMM [de] YYYY [às] HH:mm:ss"
  )} (fuso: America/Sao_Paulo)

REGRAS IMPORTANTES:
- Só ative "shouldSend": true se o usuário claramente pedir para enviar algo PARA OUTRO contato.
- Se a mensagem for um lembrete pessoal ("me lembre", "me lembrar"), então "shouldSend" deve ser false.
- Converta expressões relativas ("daqui a 10 minutos", "amanhã") em ABSOLUTO (date + time).

Responda apenas em JSON:
{
  "shouldSend": boolean,
  "recipient": "nome do contato ou apelido mencionado",
  "date": "YYYY-MM-DD" | null,
  "time": "HH:mm" | null,
  "timezone": "America/Sao_Paulo",
  "content": "conteúdo da mensagem para o destinatário"
}
`;
}

async function extractForwardMessage(text, jid) {
  if (!poe) {
    logger.warn("POE_API_KEY ausente, não é possível extrair mensagens para terceiros.");
    return null;
  }
  logger.info({ event: "openai.extractForwardMessage.start" });
  try {
    const completion = await poe.chat.completions.create({
      model: "Gemini-2.0-Flash",
      messages: [
        { role: "system", content: getForwardMessagePrompt(dayjs().tz(config.DEFAULT_TIMEZONE)) },
        { role: "user", content: text || "" },
      ],
      max_tokens: 1024,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const rawResponse = completion.choices?.[0]?.message?.content || "";
    const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (err) {
    logger.error({ event: "openai.extractForwardMessage.error", error: err.message, text });
    return null;
  }
}

/* -------------------
   CHAT RESPONSE (com limpeza de links)
   ------------------- */
async function chatResponse(text, jid) {
  const context = await getContext(jid, text);

  try {
    if (poe) {
      logger.infoWithContext("chatResponse.poe.start", { from: jid });
      const completion = await poe.chat.completions.create({
        model: "Gemini-2.0-Flash",
        messages: context,
        max_tokens: 1000,
        temperature: 0.35,
      });

      const reply = completion.choices?.[0]?.message?.content?.trim() || "";
      const cleanReply = await formatLinks(reply);

      logger.infoWithContext("chatResponse.poe.success", { from: jid });
      return cleanReply || "⚠️ Sem resposta.";
    }

    if (openai) {
      logger.infoWithContext("chatResponse.openai.start", { from: jid });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: context,
        max_tokens: 500,
        temperature: 0.5,
      });
      const reply = completion.choices?.[0]?.message?.content?.trim() || "⚠️ Sem resposta.";
      const cleanReply = await formatLinks(reply);

      logger.infoWithContext("chatResponse.openai.success", { from: jid });
      return cleanReply;
    }

    return "⚠️ Serviço de IA indisponível.";
  } catch (err) {
    logger.errorWithContext("chatResponse.error", err);
    return "⚠️ Erro ao gerar resposta.";
  }
}

/* -------------------
   TRANSCRIÇÃO / SUMMARIZE / EXTRAÇÃO
   ------------------- */
async function transcribeAudio(filePath) {
  if (!openai) return "⚠️ Serviço de IA indisponível.";
  try {
    const res = await openai.audio.transcriptions.create({
      file: require("fs").createReadStream(filePath),
      model: "gpt-4o-transcribe",
    });
    return res.text || "";
  } catch (err) {
    logger.error({ event: "audio.transcribe.error", error: err.message });
    return "";
  }
}

async function generateReminderAlert(reminderContent) {
  if (!poe) return `⏰ Lembrete: ${reminderContent}`;
  try {
    const completion = await poe.chat.completions.create({
      model: 'Gemini-2.0-Flash',
      messages: [
        { role: 'system', content: 'Você é um assistente amigável. Reescreva o seguinte lembrete de forma concisa e simpática, começando com um emoji.' },
        { role: 'user', content: reminderContent },
      ],
      max_tokens: 100,
      temperature: 0.4,
    });
    return completion.choices[0]?.message?.content?.trim() || `⏰ ${reminderContent}`;
  } catch (err) {
    logger.warn({ event: 'openai.generateReminderAlert.error', error: err.message });
    return `⏰ Lembrete: ${reminderContent}`;
  }
}

async function humanizeForwardedMessage(content, senderName) {
  if (!poe) return `Olá! ${senderName} pediu para te avisar:\n\n"${content}"`;
  try {
    const completion = await poe.chat.completions.create({
      model: 'Gemini-2.0-Flash',
      messages: [
        {
          role: 'system',
          content: `Você é um assistente de recados. Sua tarefa é reescrever uma ÚNICA mensagem natural para ser enviada a pedido de outra pessoa.
- Quem pediu o envio: ${senderName}.
- Mensagem original: "${content}".
- Saída: apenas UMA frase curta, amigável e clara, como se fosse o próprio remetente pedindo para avisar.
- Proibido listar opções, tópicos, bullets ou variações.`
        },
        { role: 'user', content: `Reescreva a mensagem de "${senderName}" para ser enviada a um terceiro. Conteúdo: "${content}"` }
      ],
      max_tokens: 200,
      temperature: 0.5,
    });
    return completion.choices[0]?.message?.content?.trim() || `Olá! ${senderName} pediu para te avisar:\n\n"${content}"`;
  } catch (err) {
    logger.warn({ event: 'openai.humanizeForwardedMessage.error', error: err.message });
    return `Olá! ${senderName} pediu para te avisar:\n\n"${content}"`;
  }
}

/* -------------------
   PESQUISA EM TEMPO REAL (com limpeza de links)
   ------------------- */
async function webSearch(query) {
  if (!poe) {
    return "⚠️ Serviço de pesquisa indisponível (POE_API_KEY ausente).";
  }

  try {
    logger.infoWithContext("webSearch.start", { query: query.slice(0, 120) });
    const completion = await poe.chat.completions.create({
      model: "Gemini-2.0-Flash",
      messages: [
        { role: "system", content: "Você é um assistente que realiza pesquisas web em tempo real quando necessário. Sempre responda em português do Brasil e inclua fontes quando possível." },
        { role: "user", content: `Pesquise e responda objetivo sobre: ${query}` }
      ],
      max_tokens: 800,
      temperature: 0.2,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "⚠️ Nenhum resultado encontrado.";
    const cleanReply = await formatLinks(reply);

    logger.infoWithContext("webSearch.success", { preview: cleanReply.slice(0, 120) });
    return cleanReply;
  } catch (err) {
    logger.errorWithContext("webSearch.error", err);
    return "⚠️ Erro ao realizar pesquisa em tempo real.";
  }
}

async function summarizeDocument(text) {
  if (!openai) return text.slice(0, 500);
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Resuma o seguinte documento em português:" },
        { role: "user", content: text },
      ],
      max_tokens: 500,
    });
    return completion.choices[0]?.message?.content?.trim() || text.slice(0, 500);
  } catch (err) {
    logger.error({ event: "document.summarize.error", error: err.message });
    return text.slice(0, 500);
  }
}

async function extractAnyText(filePath, mimetype) {
  try {
    if (mimetype.includes("pdf")) {
      const data = await pdfParse(require("fs").readFileSync(filePath));
      return data.text;
    }
    if (
      mimetype.includes("officedocument") ||
      mimetype.includes("msword")
    ) {
      const res = await mammoth.extractRawText({ path: filePath });
      return res.value;
    }
    if (mimetype.includes("spreadsheet") || mimetype.includes("excel")) {
      const wb = xlsx.readFile(filePath);
      let result = [];
      wb.SheetNames.forEach(name => {
        const sheet = xlsx.utils.sheet_to_csv(wb.Sheets[name]);
        result.push(sheet);
      });
      return result.join("\n");
    }
    return "";
  } catch (err) {
    logger.error({ event: "file.extract.error", error: err.message });
    return "";
  }
}

module.exports = {
  extractReminder,
  extractForwardMessage,
  chatResponse,
  transcribeAudio,
  generateReminderAlert,
  webSearch,
  summarizeDocument,
  extractAnyText,
  humanizeForwardedMessage, // <-- Exportar a nova função
};