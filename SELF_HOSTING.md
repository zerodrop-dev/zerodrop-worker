# Self-Hosting ZeroDrop Worker

Teams with strict compliance requirements can deploy their own instance of the ZeroDrop edge worker against their own Cloudflare account and Redis cluster. You retain full control over where email data is processed and stored.

---

## What you need

- A Cloudflare account with Workers enabled
- A domain added to Cloudflare (for Email Routing)
- An Upstash Redis database (or any Redis-compatible REST API)
- Node.js 18+ and Wrangler CLI

---

## Setup

### 1. Clone the worker repo

```bash
git clone https://github.com/zerodrop-dev/zerodrop-worker.git
cd zerodrop-worker
npm install
```

### 2. Configure wrangler.jsonc

Copy the example config and update with your account details:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "zerodrop-worker",
  "main": "src/index.js",
  "compatibility_date": "2026-05-31",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "observability": {
    "enabled": true
  },
  "ai": {
    "binding": "AI"
  }
}
```

### 3. Set your secrets

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
# paste your Upstash Redis REST URL when prompted

npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
# paste your Upstash Redis REST token when prompted
```

These are stored as encrypted secrets in Cloudflare — never in code or config files.

### 4. Deploy

```bash
npx wrangler deploy
```

### 5. Configure Cloudflare Email Routing

1. Go to your Cloudflare dashboard → your domain → **Email Routing**
2. Enable Email Routing
3. Add a catch-all rule:
   - **Action:** Send to Worker
   - **Destination:** your deployed `zerodrop-worker`

All emails sent to `*@yourdomain.com` will now be caught by your worker instance.

---

## Point the SDK at your instance

```typescript
import { ZeroDrop } from 'zerodrop-client';

const mail = new ZeroDrop(undefined, {
  baseUrl: 'https://your-dashboard.yourdomain.com'
});
```

Or set the environment variable:

```bash
ZERODROP_BASE_URL=https://your-dashboard.yourdomain.com
```

---

## Using your own Redis

The worker uses Upstash's REST API for Redis operations. If you want to use a different Redis provider:

1. Any Redis-compatible REST API works — the worker uses simple `lpush`, `expire`, and `lrange` commands
2. Update the fetch URLs in `src/index.js` to point to your Redis endpoint
3. Set your auth token via `wrangler secret put`

---

## Disabling the AI spam filter

If you want to skip Llama 3.1 spam filtering (e.g. air-gapped environments without Workers AI access), remove or comment out the AI filter block in `src/index.js`:

```javascript
// Remove or comment out this entire block:
// ============================================
// AI SPAM FILTER
// ============================================
// try {
//   const classification = await env.AI.run(...)
//   ...
// }
```

All emails will pass through without spam filtering.

---

## Architecture when self-hosted

```
Inbound email → Cloudflare Email Routing (your domain)
                      ↓
              zerodrop-worker (your Cloudflare account)
                      ↓
         Cloudflare Workers AI (your account, optional)
                      ↓
              Your Redis instance
                      ↓
         Your dashboard or the zerodrop-client SDK
```

No data leaves your Cloudflare account or your Redis instance.

---

## Cost estimate

- **Cloudflare Workers** — free tier includes 100,000 requests/day
- **Cloudflare Email Routing** — free
- **Cloudflare Workers AI** — free tier includes 10,000 neurons/day
- **Upstash Redis** — free tier includes 10,000 commands/day

For most CI pipelines, self-hosting runs entirely within free tiers.

---

## Support

For self-hosting questions, open an issue at:
→ https://github.com/zerodrop-dev/zerodrop-worker/issues
