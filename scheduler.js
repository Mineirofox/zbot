// scheduler.js
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezonePlugin = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const fs = require('fs').promises;
const REMINDERS_FILE = './reminders.json';

async function loadReminders() {
  try {
    const data = await fs.readFile(REMINDERS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

async function saveReminders(reminders) {
  // proteção contra corrupção do arquivo
  const tmpPath = REMINDERS_FILE + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(reminders, null, 2), 'utf-8');
  await fs.rename(tmpPath, REMINDERS_FILE);
}

async function scheduleReminder(reminder, sendFn) {
  const reminders = await loadReminders();
  reminder.id = Date.now().toString();
  reminder.scheduledAt = dayjs.tz(`${reminder.date} ${reminder.time}`, reminder.timezone).toISOString();
  reminders.push(reminder);
  await saveReminders(reminders);
  _armReminder(reminder, sendFn);
}

function _armReminder(reminder, sendFn) {
  const alarmTime = new Date(reminder.scheduledAt).getTime();
  const now = Date.now();
  const delay = alarmTime - now;

  if (delay > 0) {
    setTimeout(async () => {
      try {
        await sendFn(reminder.from, reminder.content);
      } catch (err) {
        console.error("❌ Falha ao enviar lembrete:", err.message);
      }
      const updated = (await loadReminders()).filter(r => r.id !== reminder.id);
      await saveReminders(updated);
    }, delay);
  }
}

async function reloadAllReminders(sendFn) {
  const reminders = await loadReminders();
  const now = Date.now();
  reminders.forEach(rem => {
    const alarmTime = new Date(rem.scheduledAt).getTime();
    if (alarmTime > now) {
      _armReminder(rem, sendFn);
    }
  });
}

async function getUserReminders(jid) {
  const reminders = await loadReminders();
  const now = Date.now();

  return reminders
    .filter(r => r.from === jid && new Date(r.scheduledAt).getTime() > now)
    .map(r => ({
      id: r.id,
      content: r.content,
      date: r.date,
      time: r.time,
      timezone: r.timezone,
      scheduledAt: r.scheduledAt
    }))
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

async function clearUserReminders(jid) {
  const reminders = await loadReminders();
  const remaining = reminders.filter(r => r.from !== jid || new Date(r.scheduledAt).getTime() <= Date.now());
  await saveReminders(remaining);
}

module.exports = { 
  scheduleReminder, 
  loadReminders, 
  saveReminders, 
  getUserReminders, 
  clearUserReminders, 
  reloadAllReminders 
};