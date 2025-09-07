const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

async function ensureContextDir() {
  try {
    await fs.access(config.CONTEXT_DIR);
  } catch {
    await fs.mkdir(config.CONTEXT_DIR, { recursive: true });
  }
}

function getContextFilePath(jid) {
  const safeJid = jid.replace(/[^\w]/g, '_');
  return path.join(config.CONTEXT_DIR, `contexto-${safeJid}.json`);
}

async function loadContext(jid) {
  await ensureContextDir();
  const filePath = getContextFilePath(jid);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const context = JSON.parse(data);
    return Array.isArray(context) ? context : [];
  } catch (err) {
    return [];
  }
}

async function summarizeContext(messages) {
  try {
    const prompt = `
Resuma em português o seguinte histórico de conversa de forma bem curta, só os pontos principais:
${messages.map(m => `[${m.role}] ${m.content}`).join('\n')}
    `;
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    return "Resumo automático indisponível.";
  }
}

async function saveContext(jid, messages) {
  await ensureContextDir();
  const filePath = getContextFilePath(jid);
  const maxSize = config.CONTEXT_WINDOW_SIZE;

  let truncated = messages.slice(-maxSize);
  if (messages.length > maxSize) {
    const oldMessages = messages.slice(0, messages.length - maxSize);
    const summary = await summarizeContext(oldMessages);
    truncated.unshift({ role: "system", content: `Resumo de conversas anteriores: ${summary}` });
  }

  await fs.writeFile(filePath, JSON.stringify(truncated, null, 2), 'utf-8');
}

async function appendToContext(jid, role, content) {
  const context = await loadContext(jid);
  const newEntry = { role, content, timestamp: new Date().toISOString() };
  context.push(newEntry);
  await saveContext(jid, context);
}

module.exports = { loadContext, saveContext, appendToContext };