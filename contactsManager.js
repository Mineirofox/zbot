/**
 * Gerencia contatos personalizados por operador (alias -> jid)
 */
const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");

const CONTACTS_FILE = path.join(__dirname, "contacts.json");

async function loadAllContacts() {
  try {
    const data = await fs.readFile(CONTACTS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    logger.warnWithContext("contacts.load", { message: "Nenhum contato encontrado, arquivo será criado." });
    return {};
  }
}

async function saveAllContacts(allContacts) {
  try {
    await fs.writeFile(CONTACTS_FILE, JSON.stringify(allContacts, null, 2));
  } catch (err) {
    logger.error({ event: "contacts.save.error", error: err.message });
  }
}

function sanitizeAlias(alias) {
  return alias.toLowerCase().trim();
}

async function setContact(ownerJid, alias, jid) {
  const all = await loadAllContacts();
  if (!all[ownerJid]) all[ownerJid] = {};
  all[ownerJid][sanitizeAlias(alias)] = jid;
  await saveAllContacts(all);
}

async function getContact(ownerJid, alias) {
  const all = await loadAllContacts();
  return all[ownerJid]?.[sanitizeAlias(alias)] || null;
}

async function listContacts(ownerJid) {
  const all = await loadAllContacts();
  return all[ownerJid] || {};
}

async function removeContact(ownerJid, alias) {
  const all = await loadAllContacts();
  if (all[ownerJid]) {
    delete all[ownerJid][sanitizeAlias(alias)];
    await saveAllContacts(all);
  }
}

module.exports = {
  setContact,
  getContact,
  listContacts,
  removeContact
};
