# zerodrop-worker

Edge infrastructure for email verification — catches inbound emails, filters spam with Llama 3.1, and auto-extracts OTPs and magic links before storing in Redis.

This is the open-source backend that powers [zerodrop.dev](https://zerodrop.dev). Runs entirely on Cloudflare's edge — no server, no SMTP, no maintenance.

```
Inbound email → Cloudflare Email Routing
                      ↓
              zerodrop-worker (this repo)
                      ↓
         Cloudflare Workers AI (Llama 3.1 spam filter)
                      ↓ (LEGITIMATE only)
              OTP + magic link extraction
                      ↓
              Upstash Redis · TTL 1800s
```

**[Documentation](https://docs.zerodrop.dev)** · [Self-Hosting Guide](https://docs.zerodrop.dev/self-hosting) · [SECURITY.md](SECURITY.md)

---

## What it does

1. **Receives email** via Cloudflare Email Routing — every email sent to `*@zerodrop-sandbox.online` triggers this worker
2. **Parses the MIME payload** — extracts from, to, subject, message-id, and raw body
3. **Runs Llama 3.1 spam filter** — classifies the email as SPAM or LEGITIMATE using Cloudflare Workers AI
4. **Drops spam silently** — spam never reaches Redis
5. **Auto-extracts OTPs and magic links** — runs regex at the edge so your test suite gets `email.otp` and `email.magicLink` directly
6. **Stores legitimate emails** in Upstash Redis — key pattern `inbox:{name}`, TTL 1800s (30 min)

---

## Environment variables

All secrets are stored as Cloudflare Worker environment variables — never in code or git history.

| Variable | Description |
|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |

The `AI` binding is configured via `wrangler.jsonc` and uses Cloudflare's built-in Workers AI — no external API key needed.

---

## Deploying your own instance

```bash
npm install
npx wrangler deploy
```

Set your environment variables in the Cloudflare dashboard or via:

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

---

## Security

- No credentials are stored in code or git history
- All secrets are Cloudflare Worker environment variables
- Spam is dropped at the edge before hitting the database
- Inboxes auto-delete after 30 minutes via Redis TTL
- Worker source is fully auditable here

For supply chain security when using the GitHub Action, pin to a specific commit SHA:

```yaml
# Instead of:
uses: zerodrop-dev/create-inbox@v1
# Pin to a specific commit:
uses: zerodrop-dev/create-inbox@4eb0c06  # v1.0.0
```

---

## Related repos

- [zerodrop-dev/zerodrop-sdk](https://github.com/zerodrop-dev/zerodrop-sdk) — TypeScript SDK
- [zerodrop-dev/create-inbox](https://github.com/zerodrop-dev/create-inbox) — GitHub Action
- [zerodrop-dev/zerodrop-playwright-example](https://github.com/zerodrop-dev/zerodrop-playwright-example) — Working Playwright example

---

## License

MIT
