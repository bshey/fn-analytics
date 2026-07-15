/**
 * Vercel serverless entrypoint — wraps the Express app as a request handler.
 * All /api/* traffic is rewritten here (see vercel.json); the SPA is served
 * statically from web/dist by Vercel's CDN, not through this function.
 *
 * NOTE: the internal Redash host is VPN-only and unreachable from Vercel, so
 * deployments must run with MOCK=1 (demo data) unless Redash is exposed via
 * Cloudflare Access (then set REDASH_API_KEY + CF_ACCESS_CLIENT_ID/SECRET).
 */
import { app } from '../server/src/app.js'

export default app
