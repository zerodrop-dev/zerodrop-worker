# Security Policy

## Overview

ZeroDrop is a disposable email inbox service built for CI/CD pipelines. This document describes the security architecture, data handling practices, and how to report vulnerabilities.

---

## Data Handling

### What gets stored
- **Inbox name** (e.g. `dark-gglag`) — derived from the recipient address
- **Raw email payload** — MIME message including headers, subject, and body
- **Received timestamp** — UTC time of receipt
- **Extracted OTP** — 4-8 digit code if detected in the email body (null otherwise)
- **Extracted magic link** — verification or reset URL if detected (null otherwise)
- **Abuse counters** — for each sending domain (or full address, for consumer
  mailbox providers), the set of inbox names it reached in the current hour.
  Used only for rate limiting; expires after 2 hours.

### What we don't store
- Authentication tokens or cookies
- Any data outside the email payload, the abuse counters above, and the logs below

Note: the raw MIME payload we store for 30 minutes includes the message's own
`Received:` headers, which typically contain the sending relay's IP address. We
don't extract or index those, but they are part of the payload until the TTL
deletes it.

### Logs
Cloudflare retains this worker's logs for 7 days. They record the sender,
recipient, subject line, and whether an OTP or magic link was found — **never
the code or link itself**. Our dashboard host and Cloudflare also keep standard
request logs (IP address, user agent, request path) for up to 7 days.

### Retention
All inbox data is stored in Upstash Redis with a **30-minute TTL**. The email and
its expiry are written in a single atomic transaction, so a message cannot be
stored without its deletion timer.

### Edge processing
Processing happens entirely inside the Cloudflare Worker at the edge — before any
data reaches Redis. The worker:
1. Validates the recipient address; malformed addresses are rejected
2. Checks the sender against an hourly cap on distinct inboxes per sending domain
3. Runs Llama 3.1 spam classification (SPAM / LEGITIMATE) via Cloudflare Workers AI
4. Extracts OTP codes and magic links from the plain-text body
5. Stores the message under `inbox:{name}` with a 1800s TTL, atomically

**Controls 2 and 3 currently run in monitoring mode.** They log what they would
block instead of blocking it, so that legitimate test mail isn't lost to a false
positive while the thresholds and the classifier are being tuned. Recipient
validation (1) does reject mail.

The worker source code is fully auditable:
→ https://github.com/zerodrop-dev/zerodrop-worker

### OTP and verification codes
OTPs and magic links are extracted at the edge using pattern matching on the
plain-text email body. Codes adjacent to a label ("code", "OTP", "verification
code", and similar) are preferred; a bare number is used only as a fallback, and
values that look like years, prices or percentages are skipped. They are stored
alongside the raw email payload in Redis and expire after 30 minutes with the
rest of the inbox data. Extraction happens entirely within Cloudflare's
infrastructure — no external service is called, and codes are never written to
logs.

---

## Client Telemetry

ZeroDrop's clients send no telemetry. The service itself necessarily sees the
mail you send to it.

- The GitHub Action generates inbox names locally on the runner — no network
  request is made during generation
- The SDKs and MCP server send no analytics, usage metrics, or environment data
- No data is collected from your CI pipeline, repository, or developer machine
- The only network requests are the inbox polls you invoke, which carry a static
  source tag (for example `?source=go-sdk`) identifying the client library

What we do see, because it arrives in the mail itself: the inbox names you use,
and the sender, subject and timestamps of messages sent to them. We use this for
usage analytics and abuse detection — see the
[Privacy Policy](https://zerodrop.dev/privacy). We have no visibility into your
repository, your build environment, or your machine.

---

## AI Spam Filter — Cloudflare Workers AI

ZeroDrop uses Llama 3.1 (8B instruct, `@cf/meta/llama-3.1-8b-instruct-fp8`) for
spam classification via **Cloudflare Workers AI**. As noted above, the filter
currently runs in monitoring mode: it classifies and logs, but does not drop mail.

**Critical compliance note:** This model runs entirely within Cloudflare's infrastructure. Email content is **never sent to an external AI provider** (OpenAI, Anthropic, Groq, or any third party). The inference happens inside the same Cloudflare Worker that receives the email — no data leaves Cloudflare's network for AI processing.

Cloudflare Workers AI specifics:
- Inference runs on Cloudflare's global edge network
- No data retention for model training
- No external API calls
- Compliant with Cloudflare's data processing terms

This means ZeroDrop's AI processing does not require a separate Data Processing Agreement (DPA) beyond your existing Cloudflare terms of service.

For teams under SOC2, GDPR, or HIPAA auditing: the spam filter processes only the email sender address and subject line — not the full body — to make a SPAM/LEGITIMATE classification. The full body is never sent to the AI model.

---

## GitHub Action Security

The `zerodrop-dev/create-inbox` Action generates inbox names **locally on the runner** — no network request is made during the generation step. The inbox address is a random string; it does not contact ZeroDrop servers until your tests begin polling.

### Supply chain hardening

Pin to a specific commit SHA rather than a floating tag:

```yaml
# Recommended for production
uses: zerodrop-dev/create-inbox@8706a59  # v1.0.0
```

### Action permissions
The Action requires no special GitHub permissions. It does not access `GITHUB_TOKEN`, repository contents, secrets, or any runner environment variables.

---

## Shared Domain Risk

The free tier routes email through a shared domain (`zerodrop-sandbox.online`). This domain is used by many developers for CI testing.

**Risk:** Shared sending domains can be flagged by disposable email detection libraries used by some identity providers (Auth0, Clerk, and similar). If your application rejects disposable email addresses, tests using the free tier sandbox domain will fail.

**Also worth knowing:** on the free tier, the inbox name *is* the access control.
Anyone who knows or guesses a name can read that inbox. Names are random and
generated client-side, and mail is deleted after 30 minutes, but the free tier is
not the right place for anything sensitive.

**Mitigation:** Production CI pipelines should use ZeroDrop Workspaces, which
receive mail on a domain used only by your team rather than the shared sandbox
domain, so shared-domain blocklists don't apply. Workspaces are set up
individually with each customer today — email founder@zerodrop.dev.

---

## Self-Hosting

The Cloudflare Worker that receives and processes emails is fully open source. Teams with strict compliance requirements can deploy their own instance against their own Cloudflare account and Redis cluster.

→ See [SELF_HOSTING.md](https://github.com/zerodrop-dev/zerodrop-worker/blob/master/SELF_HOSTING.md) in the worker repo.

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| v1.x    | ✅ Yes    |

---

## Reporting a Vulnerability

If you discover a security vulnerability in ZeroDrop, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **security@zerodrop.dev**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We will acknowledge receipt within 48 hours and aim to resolve critical issues within 7 days.

---

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| Inbox enumeration | Names are random and generated client-side; the 30-minute TTL limits the window. But the name is the only access control on the free tier — treat free-tier inboxes as public |
| Data persistence | Hard Redis TTL, written atomically with the message — data cannot persist beyond 30 minutes regardless of application logic |
| Malformed recipient addresses | Validated at the worker and in the read API; only `[a-z0-9._+-]` names up to 64 characters are accepted |
| Supply chain attack via Action | SHA pinning documented; worker source is auditable |
| OTP theft | 30-min TTL limits exposure window; codes are never written to logs; on the free tier they're accessible to whoever knows the inbox name |
| Spam and registration farming | Hourly cap on distinct inboxes per sending domain, plus Llama 3.1 classification — both in monitoring mode while being tuned; see Edge processing |
| AI data leak | Cloudflare Workers AI — inference runs on Cloudflare's network, no external AI provider |
| Shared domain blocklist | Free tier risk documented; Workspaces use a domain dedicated to your team |

---

## Contact

- Security disclosures: security@zerodrop.dev
- General: zerodrop.dev
