import { app } from './app.js'
import { config } from './config.js'

app.listen(config.port, '127.0.0.1', () => {
  console.log(
    `fn-analytics server on http://127.0.0.1:${config.port}` +
      (config.mock ? ' [MOCK MODE — demo data]' : '') +
      (!config.mock && !config.apiKey ? ' [WARNING: REDASH_API_KEY not set — queries will fail until .env is configured]' : ''),
  )
})
