const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezonePlugin = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const fs = require('fs').promises;
const config = require('./config');
const logger = require('./logger');

const REMINDERS_FILE = config.REMINDERS_FILE;

async function loadReminders() {
  try {
    const data = await fs.readFile(REMINDERS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error({ event: 'reminders.load.error', error: err.message });
    }
    return [];
  }
}

async function saveReminders(reminders) {
  const tmpPath = REMINDERS_FILE + '.tmp';
  try {
    await fs.writeFile(tmpPath, JSON.stringify(reminders, null, 2), 'utf-8');
    await fs.rename(tmpPath, REMINDERS_FILE);
  } catch (err) {
    logger.error({ event: 'reminders.save.error', error: err.message });
  }
}

async function scheduleReminder(reminder, sendFn) {
  const reminders = await loadReminders();
  reminder.id = Date.now().toString();

  // CORREÇÃO: Usar formato de parsing explícito
  reminder.scheduledAt = dayjs.tz(
    `${reminder.date} ${reminder.time}`,
    'YYYY-MM-DD HH:mm',
    reminder.timezone
  ).toISOString();

  reminders.push(reminder);
  await saveReminders(reminders);
  _armReminder(reminder, sendFn);
}

function _armReminder(reminder, sendFn) {
  const now = dayjs().tz(reminder.timezone);
  const scheduledTime = dayjs(reminder.scheduledAt).tz(reminder.timezone);
  const delay = scheduledTime.diff(now, 'millisecond');

  if (delay > 0) {
    setTimeout(async () => {
      try {
        await sendFn(reminder.from, reminder.content);
      } catch (err) {
        logger.error({ event: 'reminder.send.failed', error: err.message });
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
  const filtered = reminders.filter(r => r.from !== jid);
  await saveReminders(filtered);
}

module.exports = {
  scheduleReminder,
  reloadAllReminders,
  getUserReminders,
  clearUserReminders
};