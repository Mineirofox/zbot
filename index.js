if (process.platform === 'win32') {
  const exec = require('child_process').exec;
  const cmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';
  exec(`powershell -Command "${cmd}"`, (error) => {
    if (!error) console.log('[ENCODING] UTF-8 ativado ✔');
  });
}

const { startBot } = require('./bot');
const { loadReminders, saveReminders } = require('./scheduler');
const logger = require('./logger');
require('./bot');

logger.info('🚀 Inicializando bot de lembretes no WhatsApp...');

async function reloadScheduledReminders() {
  try {
    const reminders = await loadReminders();
    logger.info({ event: 'scheduler.reloaded', count: reminders.length });
    for (const reminder of reminders) {
      const now = Date.now();
      const alarmTime = new Date(reminder.scheduledAt).getTime();
      if (alarmTime > now) {
        const delay = alarmTime - now;
        setTimeout(async () => {
          await require('./bot').sendMessage(reminder.from, `⏰ Lembrete: ${reminder.content}`);
          const updated = (await loadReminders()).filter(r => r.id !== reminder.id);
          await saveReminders(updated);
          logger.info({ event: 'reminder.fired', id: reminder.id });
        }, delay);
      }
    }
  } catch (err) {
    logger.error({ event: 'reload.failed', error: err.message });
  }
}

startBot();
reloadScheduledReminders().catch(console.error);