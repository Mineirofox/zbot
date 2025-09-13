/**
 * Gerencia o histórico de contexto por usuário
 * Armazena mensagens multimodais (texto, áudio, imagem, documento, avisos)
 */
const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");
const config = require("./config");

const CONTEXTS_FILE = path.join(__dirname, config.CONTEXTS_FILE);

async function loadContexts() {
  try {
    const data = await fs.readFile(CONTEXTS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    logger.warnWithContext("context.load", { message: "Nenhum contexto salvo." });
    return {};
  }
}

async function saveContexts(contexts) {
  try {
    await fs.writeFile(CONTEXTS_FILE, JSON.stringify(contexts, null, 2));
  } catch (err) {
    logger.error({ event: "context.save.error", error: err.message });
  }
}

/**
 * Adiciona algo ao contexto
 */
async function appendToContext(userId, role, content, origin = "text") {
  const contexts = await loadContexts();
  if (!contexts[userId]) {
    contexts[userId] = [];
  }

  const safeContent = typeof content === "string" ? content : String(content || "");

  contexts[userId].push({
    timestamp: new Date().toISOString(),
    role,
    origin,
    content: safeContent,
  });

  if (contexts[userId].length > config.CONTEXT_WINDOW_SIZE) {
    contexts[userId] = contexts[userId].slice(-config.CONTEXT_WINDOW_SIZE);
  }

  await saveContexts(contexts);
}

/**
 * Obtém o histórico de contexto formatado
 */
async function getContext(userId, latestMessage) {
  const contexts = await loadContexts();
  const context = contexts[userId] || [];

  const formattedContext = context
    .filter(msg => typeof msg.content === "string" && msg.content.trim() !== "")
    .map(msg => ({
      role: msg.role,
      content: msg.content,
    }));

  if (latestMessage && typeof latestMessage === "string" && latestMessage.trim() !== "") {
    formattedContext.push({ role: "user", content: latestMessage });
  }

  const systemMessage = {
    role: "system",
    content: `Você é o bot do WhatsApp, 'Gemini-2.0-Flash'.
    Responda em português do Brasil e leve em conta o histórico de conversa.`,
  };

  return [systemMessage, ...formattedContext];
}

module.exports = {
  appendToContext,
  getContext,
};