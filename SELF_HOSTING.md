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
  }
}
```

### 3. Set your secrets

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
# paste your Upstash Redis REST URL when prompted

npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
# paste your Upstash Redis REST token when prompted

npx wrangler secret put CAP_ALLOWLIST
# optional: comma-separated parent domains exempt from the keyless allowance
# (example.com covers noreply@mail.example.com; mail.example.com matches nothing)

npx wrangler secret put ALLOWLIST_UNTIL
# optional: a date (YYYY-MM-DD, UTC) after which CAP_ALLOWLIST stops applying

npx wrangler secret put ALLOWANCE_MODE
# optional: "off" to stop counting, "shadow" to log only

npx wrangler secret put INBOX_ENCRYPTION_KEY
# optional: 32 random bytes, base64, e.g. from
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# With it set, emails are encrypted with AES-256-GCM before they're stored.
# Whatever reads your inboxes must decrypt them with the same key (the format
# is in src/encryption.js), so leave it unset if yours doesn't.

npx wrangler secret put INBOX_ENCRYPTION_REQUIRED
# optional: "true" makes the worker store nothing rather than store an email
# unencrypted, should INBOX_ENCRYPTION_KEY ever go missing

npx wrangler secret put DOMAIN_MODE
# type: open. Required on your own domain: without it, the worker accepts mail
# only for zerodrop-sandbox.online and Workspace domains registered in Redis,
# and rejects mail to yours ("Unknown recipient domain")
```

These are stored as encrypted secrets in Cloudflare — never in code or config files.

**The keyless allowance doesn't apply on your own domain.** The worker counts only mail to `zerodrop-sandbox.online`, ZeroDrop's shared domain, so `CAP_ALLOWLIST`, `ALLOWLIST_UNTIL` and `ALLOWANCE_MODE` don't matter on a self-hosted instance.

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

The other SDKs take a base URL option the same way. The MCP server reads it from an environment variable instead:

```bash
ZERODROP_BASE_URL=https://your-dashboard.yourdomain.com
```

---

## Using your own Redis

The worker uses Upstash's REST API for Redis operations. If you want to use a different Redis provider:

1. Any REST API compatible with Upstash's works — the worker sends everything to `/pipeline`: `GET` for account and Workspace records, and `EVAL` for two short Lua scripts, one that counts the keyless allowance and one that stores each email (`LPUSH`, `LTRIM`, `TTL` and `EXPIRE`). It reads keys named `ns:{prefix}`, `ttl:{prefix}` and `domain:{domain}`, so keep those names free for it
2. Update the fetch URLs in `src/index.js` to point to your Redis endpoint
3. Set your auth token via `wrangler secret put`

---

## Architecture when self-hosted

```
Inbound email → Cloudflare Email Routing (your domain)
                      ↓
              zerodrop-worker (your Cloudflare account)
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
- **Upstash Redis** — free tier includes 10,000 commands/day

For most CI pipelines, self-hosting runs entirely within free tiers.

---

## Support

For self-hosting questions, open an issue at:
→ https://github.com/zerodrop-dev/zerodrop-worker/issues
