/**
 * Gerencia contatos personalizados (alias -> jid)
 */
const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");

const CONTACTS_FILE = path.join(__dirname, "contacts.json");

async function loadContacts() {
  try {
    const data = await fs.readFile(CONTACTS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    logger.warnWithContext("contacts.load", { message: "Nenhum contato encontrado, arquivo será criado." });
    return {};
  }
}

async function saveContacts(contacts) {
  try {
    await fs.writeFile(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
  } catch (err) {
    logger.error({ event: "contacts.save.error", error: err.message });
  }
}

function sanitizeAlias(alias) {
  return alias.toLowerCase().trim();
}

async function setContact(alias, jid) {
  const contacts = await loadContacts();
  contacts[sanitizeAlias(alias)] = jid;
  await saveContacts(contacts);
}

async function getContact(alias) {
  const contacts = await loadContacts();
  return contacts[sanitizeAlias(alias)] || null;
}

async function listContacts() {
  return await loadContacts();
}

async function removeContact(alias) {
  const contacts = await loadContacts();
  delete contacts[sanitizeAlias(alias)];
  await saveContacts(contacts);
}

module.exports = {
  setContact,
  getContact,
  listContacts,
  removeContact
};