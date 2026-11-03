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
     Upstash Redis · TTL 30 min (a Workspace's own: up to 7 days)
```

**[Documentation](https://docs.zerodrop.dev)** · [Self-Hosting Guide](https://docs.zerodrop.dev/self-hosting) · [SECURITY.md](SECURITY.md)

---

## What it does

1. **Receives email** via Cloudflare Email Routing — every email sent to `*@zerodrop-sandbox.online`, or to a Workspace's own domain, triggers this worker
2. **Validates the recipient** — malformed inbox names and domains are rejected, and the domain is put in one canonical form (lower case, an internationalized name in its `xn--` form). Mail to a Workspace's own domain is filed under the owner's account prefix (`swift-x7k29ab@qa.example` → inbox `k7x2-swift-x7k29ab`), so only the owner's key can read it. Mail to any other domain is rejected, unless `DOMAIN_MODE` is `open`
3. **Rejects blocked senders** — a short list of platforms whose verification codes were being farmed through free inboxes, on every domain, a Workspace's included
4. **Checks the account prefix** — mail to a suspended or deleted account's prefix (`k7x2-…`) is rejected, because nobody can read it; an active account's inboxes aren't counted in step 5
5. **Applies a keyless allowance** — without an API key, one sender can reach 5 different inboxes a day on `zerodrop-sandbox.online` (counted per address for consumer mailbox providers; mail to a Workspace's own domain isn't counted). Mail past it is held: it isn't stored, and the inbox gets a short notice saying why and where to get a free key
6. **Auto-extracts OTPs and magic links** at the edge, so your test suite gets `email.otp` and `email.magicLink` directly
7. **Stores the email** in Upstash Redis — key `inbox:{name}`, TTL 1800s (30 min), or the account's own retention for a Workspace (up to 7 days), written by one atomic script with its expiry. A new email restarts its inbox's timer but never shortens it, and each inbox keeps its newest 50 emails. With `INBOX_ENCRYPTION_KEY` set, the email is encrypted with AES-256-GCM first

---

## Environment variables

Secrets are stored as Cloudflare Worker secrets — never in code or git history.

| Variable | Description |
|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `CAP_ALLOWLIST` | Optional. Comma-separated parent domains whose mail is exempt from the keyless allowance (`example.com` covers `noreply@mail.example.com`; `mail.example.com` matches nothing) |
| `ALLOWLIST_UNTIL` | Optional. A date (`YYYY-MM-DD`, UTC) after which `CAP_ALLOWLIST` stops applying |
| `ALLOWANCE_MODE` | Optional. `shadow` logs what the keyless allowance would hold but stores the mail anyway; `off` stops counting. Unset, the allowance is enforced |
| `INBOX_ENCRYPTION_KEY` | Optional. 32 random bytes, base64. With it set, every email (and every held-mail notice) is encrypted with AES-256-GCM before it leaves the worker, bound to its inbox; whatever reads the inboxes needs the same key (the format is in [`src/encryption.js`](src/encryption.js)). Unset, emails are stored as plain JSON. A value that isn't 32 bytes, an empty one included, makes the worker store nothing rather than store mail unencrypted |
| `INBOX_ENCRYPTION_REQUIRED` | Optional. `true` makes the worker store nothing rather than store an email unencrypted, should `INBOX_ENCRYPTION_KEY` ever be missing. Any value but `0`, `false`, `no` or `off` turns it on |
| `DOMAIN_MODE` | Unset (or `strict`), mail to any domain but `zerodrop-sandbox.online` and the Workspace domains registered in Redis is rejected. `open` stores mail to an unregistered domain by its local part, as before Workspaces: a self-hosted worker on its own domain needs it |

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
npx wrangler secret put ALLOWANCE_MODE    # optional
npx wrangler secret put INBOX_ENCRYPTION_KEY  # optional, see above
npx wrangler secret put INBOX_ENCRYPTION_REQUIRED  # optional
npx wrangler secret put DOMAIN_MODE       # "open" for a worker on your own domain
```

---

## Security

- No credentials are stored in code or git history
- All secrets are Cloudflare Worker secrets
- Blocked senders are rejected at the edge, before anything is stored
- Mail held by the keyless allowance is never parsed or stored
- An inbox is deleted 30 minutes after its latest message (or after a Workspace's own retention, at most 7 days), by a Redis TTL written atomically with each message
- With `INBOX_ENCRYPTION_KEY` set, each email reaches Redis as ciphertext: encrypted with AES-256-GCM in the worker, with a fresh IV, and bound to its inbox so it can't be moved to another. Inbox names (the Redis keys), the allowance counters and account records stay readable
- The worker never writes one-time codes or subject lines to its logs
- Worker source is fully auditable here — see [SECURITY.md](SECURITY.md)

For supply chain security when using the GitHub Action, pin to a specific commit SHA:

```yaml
# Instead of:
uses: zerodrop-dev/setup-zerodrop@v1
# Pin to a specific commit:
uses: zerodrop-dev/setup-zerodrop@aa882ace46b204bfd84bbcc374df73d32cf67343  # v1.1.0
```

---

## Related repos

- [zerodrop-dev/zerodrop-sdk](https://github.com/zerodrop-dev/zerodrop-sdk) — TypeScript SDK
- [zerodrop-dev/setup-zerodrop](https://github.com/zerodrop-dev/setup-zerodrop) — GitHub Action
- [zerodrop-dev/zerodrop-playwright-example](https://github.com/zerodrop-dev/zerodrop-playwright-example) — Working Playwright example

---

## License

MIT
