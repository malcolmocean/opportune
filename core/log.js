export const log = (mod) => {
  const p = (lvl, args) => console[lvl === 'error' ? 'error' : 'log'](`[${new Date().toISOString().slice(11, 19)}] [${mod}]`, ...args)
  return { info: (...a) => p('info', a), warn: (...a) => p('warn', a), error: (...a) => p('error', a), debug: (...a) => process.env.DEBUG && p('debug', a) }
}
