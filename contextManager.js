const fs = require('fs').promises;
const path = require('path');
const config = require('./config');

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

async function saveContext(jid, messages) {
  await ensureContextDir();
  const filePath = getContextFilePath(jid);
  const maxSize = config.CONTEXT_WINDOW_SIZE;
  const truncated = messages.slice(-maxSize);
  await fs.writeFile(filePath, JSON.stringify(truncated, null, 2), 'utf-8');
}

async function appendToContext(jid, role, content) {
  const context = await loadContext(jid);
  const newEntry = { role, content, timestamp: new Date().toISOString() };
  context.push(newEntry);
  await saveContext(jid, context);
}

module.exports = { loadContext, saveContext, appendToContext };