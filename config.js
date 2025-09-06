require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ ERRO: Variável de ambiente "${name}" não está definida no .env`);
    process.exit(1);
  }
  return value;
}

module.exports = {
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo',
  CONTEXT_WINDOW_SIZE: parseInt(process.env.CONTEXT_WINDOW_SIZE) || 30,
  CONTEXT_DIR: './context'
};