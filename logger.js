const pino = require('pino');
const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');

// pasta de logs
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// cria nome do arquivo com a data do dia
const logFile = path.join(logDir, `app-${dayjs().format('YYYY-MM-DD')}.log`);

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: 'whatsapp-bot',
    },
    timestamp: () => `,"time":"${dayjs().format('YYYY-MM-DD HH:mm:ss')}"`,
    serializers: {
      err: (err) => {
        if (!err) return null;
        return {
          type: err.name,
          message: err.message,
          stack: err.stack,
        };
      },
    },
    transport: {
      targets: [
        {
          target: 'pino-pretty', // console limpo
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,service',
          },
        },
        {
          target: 'pino/file', // salva em arquivo diário
          options: {
            destination: logFile,
            mkdir: true,
            append: true,
          },
        },
      ],
    },
  }
);

// atalhos com mais info em erros
logger.errorWithContext = (context, err) => {
  logger.error({ event: context, err }, `❌ Erro em ${context}: ${err.message}`);
};
logger.infoWithContext = (context, meta = {}) => {
  logger.info({ event: context, ...meta }, `ℹ️  ${context}`);
};
logger.warnWithContext = (context, meta = {}) => {
  logger.warn({ event: context, ...meta }, `⚠️  ${context}`);
};
logger.debugWithContext = (context, meta = {}) => {
  logger.debug({ event: context, ...meta }, `🐛  ${context}`);
};

module.exports = logger;