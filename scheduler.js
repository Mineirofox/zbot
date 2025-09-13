const fs = require("fs").promises;
const path = require("path");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezonePlugin = require("dayjs/plugin/timezone");
const { v4: uuidv4 } = require("uuid");
const logger = require("./logger");
// 🔥 IA para mensagens humanizadas (importando ambas as funções)
const { generateReminderAlert, humanizeForwardedMessage } = require("./openai");

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const REMINDERS_FILE = path.join(__dirname, "reminders.json");
let scheduledTasks = {};

// === persistência ===
async function loadReminders() {
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveReminders(reminders) {
  try {
    await fs.writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
  } catch (err) {
    logger.errorWithContext("scheduler.saveReminders.error", err);
  }
}

// === agendamento interno ===
async function scheduleReminder(reminder, cb, confirmCb = null) {
  if (!reminder.id) reminder.id = uuidv4();

  const reminders = await loadReminders();
  reminders.push(reminder);
  await saveReminders(reminders);

  const run = async () => {
    try {
      logger.infoWithContext("scheduler.trigger", { reminder });

      // verificar se ainda existe no arquivo (evita bug se foi cancelado)
      const all = await loadReminders();
      if (!all.find(r => r.id === reminder.id)) {
        logger.warnWithContext("scheduler.skip.deleted", { reminder });
        return;
      }
      
      let finalMessage = "";
      // Decide qual tipo de mensagem gerar com base nas propriedades do lembrete
      if (reminder.recipient && reminder.fromAlias && reminder.recipient !== reminder.from) {
        // É uma mensagem para um terceiro, requisitada por 'fromAlias'
        logger.infoWithContext("scheduler.humanize.forward", { from: reminder.fromAlias });
        finalMessage = await humanizeForwardedMessage(reminder.content, reminder.fromAlias);
      } else {
        // É um lembrete pessoal
        logger.infoWithContext("scheduler.humanize.personal", { for: reminder.from });
        finalMessage = await generateReminderAlert(reminder.content);
      }

      const target = reminder.recipient || reminder.from;
      await cb(target, finalMessage);

      // confirmação para quem criou (se aplicável e se for diferente do alvo)
      if (confirmCb && reminder.from !== target) {
        await confirmCb(reminder.from, reminder);
      }

      // remover do arquivo após execução
      const left = all.filter(r => r.id !== reminder.id);
      await saveReminders(left);
      delete scheduledTasks[reminder.id];
    } catch (err) {
      logger.errorWithContext("scheduler.trigger.error", err);
    }
  };

  const scheduledAt = dayjs(`${reminder.date} ${reminder.time}`).tz(reminder.timezone, true);
  const delay = scheduledAt.diff(dayjs());

  if (delay <= 0) {
    logger.warnWithContext("scheduler.past", { reminder });
    run(); // Executa imediatamente se o tempo já passou
    return;
  }

  scheduledTasks[reminder.id] = setTimeout(run, delay);

  logger.infoWithContext("scheduler.scheduled", {
    id: reminder.id,
    at: scheduledAt.format(),
    to: reminder.recipient || reminder.from,
    preview: reminder.content?.slice(0, 50)
  });
}

// === reativar lembretes salvos ao reiniciar ===
async function restoreReminders(cb, confirmCb = null) {
  const reminders = await loadReminders();
  const now = dayjs();
  
  const validReminders = [];
  
  for (const reminder of reminders) {
    const scheduledAt = dayjs(`${reminder.date} ${reminder.time}`).tz(reminder.timezone, true);
    if (scheduledAt.isAfter(now)) {
      scheduleReminder(reminder, cb, confirmCb);
      validReminders.push(reminder);
    } else {
       logger.warnWithContext("scheduler.restore.expired", { reminder });
    }
  }

  // Limpa lembretes expirados do arquivo de uma só vez
  if (validReminders.length !== reminders.length) {
    await saveReminders(validReminders);
  }
}


// === utilitários ===
async function getUserReminders(jid) {
  const reminders = await loadReminders();
  return reminders.filter(r => r.from === jid);
}

async function clearUserReminders(jid) {
  const reminders = await loadReminders();
  const left = reminders.filter(r => r.from !== jid);
  
  // cancelar timers também
  const toCancel = reminders.filter(r => r.from === jid);
  for (const r of toCancel) {
    if (scheduledTasks[r.id]) {
      clearTimeout(scheduledTasks[r.id]);
      delete scheduledTasks[r.id];
      logger.infoWithContext("scheduler.timer.cancelled", { id: r.id });
    }
  }

  await saveReminders(left);
}

module.exports = {
  scheduleReminder,
  restoreReminders,
  getUserReminders,
  clearUserReminders,
  saveReminders,
  loadReminders
};