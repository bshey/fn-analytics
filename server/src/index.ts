import { networkInterfaces } from 'node:os'
import { app } from './app.js'
import { config } from './config.js'

function lanAddresses(): string[] {
  const out: string[] = []
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address)
    }
  }
  return out
}

app.listen(config.port, config.host, () => {
  const shared = config.host !== '127.0.0.1'
  const urls = shared
    ? [`http://127.0.0.1:${config.port}`, ...lanAddresses().map((a) => `http://${a}:${config.port}`)]
    : [`http://127.0.0.1:${config.port}`]
  console.log(
    `fn-analytics server on ${urls.join('  |  ')}` +
      (shared ? ' [shared on the local network — anyone who can reach this machine can use the app]' : '') +
      (config.mock ? ' [MOCK MODE — demo data]' : '') +
      (!config.mock && !config.apiKey ? ' [WARNING: REDASH_API_KEY not set — queries will fail until .env is configured]' : ''),
  )
})
