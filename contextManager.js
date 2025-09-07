// contextManager.js
/**
 * Gerencia o histórico de contexto por usuário
 * Armazena mensagens multimodais (texto, áudio, imagem, documento, avisos)
 */

const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");

const CONTEXTS_FILE = path.join(__dirname, "contexts.json");

// Carregar contextos do disco
async function loadContexts() {
  try {
    const data = await fs.readFile(CONTEXTS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Salvar contextos no disco
async function saveContexts(contexts) {
  try {
    await fs.writeFile(CONTEXTS_FILE, JSON.stringify(contexts, null, 2));
  } catch (err) {
    logger.error({ event: "context.save.error", error: err.message });
  }
}

/**
 * Adiciona algo ao contexto
 * @param {string} userId - JID do usuário
 * @param {string} role - Quem falou (user | assistant | system)
 * @param {string} content - O texto associado
 * @param {string} [origin="text"] - Origem da mensagem (text | audio | image | document | notice)
 */
async function appendToContext(userId, role, content, origin = "text") {
  const contexts = await loadContexts();
  if (!contexts[userId]) {
    contexts[userId] = [];
  }

  contexts[userId].push({
    timestamp: new Date().toISOString(),
    role,
    origin,
    content,
  });

  // Mantém o histórico enxuto (últimas 30 entradas)
  if (contexts[userId].length > 30) {
    contexts[userId] = contexts[userId].slice(-30);
  }

  await saveContexts(contexts);
  logger.info({ event: "context.appended", userId, role, origin, preview: content.slice(0, 50) });
}

// Recuperar contexto de um usuário
async function getContext(userId) {
  const contexts = await loadContexts();
  return contexts[userId] || [];
}

// Resetar contexto de um usuário
async function resetContext(userId) {
  const contexts = await loadContexts();
  contexts[userId] = [];
  await saveContexts(contexts);
  logger.info({ event: "context.reset", userId });
}

module.exports = {
  appendToContext,
  getContext,
  resetContext,
};