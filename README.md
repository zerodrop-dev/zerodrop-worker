# zerodrop-worker

Edge infrastructure for email verification — catches inbound emails, applies abuse controls, and auto-extracts OTPs and magic links before storing in Redis.

This is the open-source backend that powers [zerodrop.dev](https://zerodrop.dev). Runs entirely on Cloudflare's edge — no server, no SMTP, no maintenance.

```
Inbound email → Cloudflare Email Routing
                      ↓
              zerodrop-worker (this repo)
  recipient check · sender blocklist · daily keyless allowance
                      ↓
              OTP + magic link extraction
                      ↓
              Upstash Redis · TTL 1800s
```

**[Documentation](https://docs.zerodrop.dev)** · [Self-Hosting Guide](https://docs.zerodrop.dev/self-hosting) · [SECURITY.md](SECURITY.md)

---

## What it does

1. **Receives email** via Cloudflare Email Routing — every email sent to `*@zerodrop-sandbox.online` triggers this worker
2. **Validates the recipient** — malformed inbox names are rejected
3. **Rejects blocked senders** — a short list of platforms whose verification codes were being farmed through free inboxes
4. **Counts a keyless allowance** — without an API key, one sender can reach 5 different inboxes a day (counted per address for consumer mailbox providers); inboxes under an account's namespace aren't counted — monitoring mode: logged, not enforced
5. **Auto-extracts OTPs and magic links** at the edge, so your test suite gets `email.otp` and `email.magicLink` directly
6. **Stores the email** in Upstash Redis — key `inbox:{name}`, TTL 1800s (30 min), written atomically with its expiry

---

## Environment variables

Secrets are stored as Cloudflare Worker secrets — never in code or git history.

| Variable | Description |
|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `CAP_ALLOWLIST` | Optional. Comma-separated sender domains exempt from the keyless allowance |
| `ALLOWLIST_UNTIL` | Optional. A date (`YYYY-MM-DD`, UTC) after which `CAP_ALLOWLIST` stops applying |

No other bindings are needed. The worker runs no AI model.

---

## Deploying your own instance

```bash
npm install
npx wrangler deploy
```

Set your secrets in the Cloudflare dashboard or via:

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler secret put CAP_ALLOWLIST     # optional
npx wrangler secret put ALLOWLIST_UNTIL   # optional
```

---

## Security

- No credentials are stored in code or git history
- All secrets are Cloudflare Worker secrets
- Blocked senders are rejected at the edge, before anything is stored
- Inboxes auto-delete after 30 minutes via Redis TTL, written atomically with each message
- The worker never writes one-time codes or subject lines to its logs
- Worker source is fully auditable here — see [SECURITY.md](SECURITY.md)

For supply chain security when using the GitHub Action, pin to a specific commit SHA:

```yaml
# Instead of:
uses: zerodrop-dev/setup-zerodrop@v1
# Pin to a specific commit:
uses: zerodrop-dev/setup-zerodrop@36c6685cce921fbe8b6353a71292c8e262124e3e  # v1.0.0
```

---

## Related repos

- [zerodrop-dev/zerodrop-sdk](https://github.com/zerodrop-dev/zerodrop-sdk) — TypeScript SDK
- [zerodrop-dev/setup-zerodrop](https://github.com/zerodrop-dev/setup-zerodrop) — GitHub Action
- [zerodrop-dev/zerodrop-playwright-example](https://github.com/zerodrop-dev/zerodrop-playwright-example) — Working Playwright example

---

## License

MIT
