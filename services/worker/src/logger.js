export const logger = {
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', msg, ...data, time: new Date().toISOString() })),
  warn: (msg, data) => console.log(JSON.stringify({ level: 'warn', msg, ...data, time: new Date().toISOString() })),
  error: (msg, data) => console.error(JSON.stringify({ level: 'error', msg, ...data, time: new Date().toISOString() })),
};
