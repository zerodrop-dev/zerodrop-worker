# Security Policy

## Overview

ZeroDrop is a disposable email inbox service built for CI/CD pipelines. This document describes the security architecture, data handling practices, and how to report vulnerabilities.

---

## Data Handling

### What gets stored
- **Inbox name** (e.g. `swift-x7k2m`) — derived from the recipient address
- **Raw email payload** — MIME message including headers, subject, and body
- **Received timestamp** — UTC time of receipt
- **Extracted OTP** — 4-8 digit code if detected in the email body (null otherwise)
- **Extracted magic link** — verification or reset URL if detected (null otherwise)

### What never gets stored
- Sender IP addresses
- Authentication tokens or cookies
- Any data outside the email payload itself

### Retention
All inbox data is stored in Upstash Redis with a **30-minute TTL**. After 30 minutes, the key is automatically deleted by Redis — no manual cleanup required, no data persists.

### Edge parsing
Email parsing happens entirely inside the Cloudflare Worker at the edge — before any data reaches Redis. The worker:
1. Extracts from, to, subject, message-id, and raw body from the MIME payload
2. Runs Llama 3.1 spam classification (SPAM / LEGITIMATE) via Cloudflare Workers AI
3. Silently drops spam — it never reaches Redis
4. Extracts OTP codes and magic links via regex on the plain-text body
5. Stores only legitimate emails under `inbox:{name}` with a 1800s TTL

The worker source code is fully auditable:
→ https://github.com/zerodrop-dev/zerodrop-worker

### OTP and verification codes
OTPs and magic links are extracted at the edge using regex pattern matching on the plain-text email body. They are stored alongside the raw email payload in Redis and expire after 30 minutes along with the rest of the inbox data. Extraction happens entirely within Cloudflare's infrastructure — no external service is called.

---

## Zero Telemetry

ZeroDrop does not track your test suites, build environments, project names, or CI runner metadata.

- The GitHub Action generates inbox names locally on the runner — no network request is made during generation
- The SDK does not send analytics, usage metrics, or environment data to any server
- No telemetry is collected from your CI pipeline, repository, or developer machine
- The only network requests made are explicit inbox polls to `zerodrop.dev/api/inbox/{name}` — nothing else

Your CI pipeline is your business. We have no visibility into what you're testing, what your project is called, or what environment you're running in.

---

## AI Spam Filter — Cloudflare Workers AI

ZeroDrop uses Llama 3.1 (8B instruct) for spam classification via **Cloudflare Workers AI**.

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

**Mitigation:** Production CI pipelines should use ZeroDrop Workspaces with a custom domain (`@testing.yourcompany.com`). Custom domains are private, isolated, and not shared with other users — they will not appear on disposable email blocklists.

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
| Inbox enumeration | Inbox names are random 9-character strings — brute force is impractical within the 30-min window |
| Data persistence | Hard Redis TTL — data cannot persist beyond 30 minutes regardless of application logic |
| Supply chain attack via Action | SHA pinning documented; worker source is auditable |
| OTP theft | 30-min TTL limits exposure window; OTPs are only accessible to whoever knows the inbox name |
| Spam flooding | Llama 3.1 spam filter drops automated spam at the edge before Redis writes |
| AI data leak | Cloudflare Workers AI — inference runs on Cloudflare's network, no external AI provider |
| Shared domain blocklist | Free tier risk documented; Workspaces custom domains are isolated and private |

---

## Contact

- Security disclosures: security@zerodrop.dev
- General: zerodrop.dev
