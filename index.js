if (process.platform === 'win32') {
  const exec = require('child_process').exec;
  const cmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';
  exec(`powershell -Command "${cmd}"`, (error) => {
    if (!error) console.log('[ENCODING] UTF-8 ativado ✔');
  });
}

const { startBot, sendMessage } = require('./bot');
const { reloadAllReminders } = require('./scheduler');
const logger = require('./logger');

logger.info('🚀 Inicializando bot de lembretes no WhatsApp...');

startBot();

// ✅ usa função centralizada no scheduler
reloadAllReminders(async (to, content) => {
  await sendMessage(to, `⏰ Lembrete: ${content}`);
}).catch(err => logger.error({ event: 'reload.failed', error: err.message }));