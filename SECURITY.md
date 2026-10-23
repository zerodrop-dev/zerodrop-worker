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
  mailbox providers), the set of inbox names it reached in the current UTC day.
  Used only for the keyless allowance; expires after 2 days.
- **Held-mail notices** — when the keyless allowance holds an email, the inbox
  gets a short notice from `notice@zerodrop.dev` in its place, naming only the
  sender's domain. The held email itself is not stored. A notice is deleted with
  its inbox, like any other message.

### What we don't store
- Authentication tokens or cookies
- Any data outside the email payload, the abuse counters above, and the logs below

Note: the raw MIME payload we store until the inbox expires includes the message's own
`Received:` headers, which typically contain the sending relay's IP address. We
don't extract or index those, but they are part of the payload until the TTL
deletes it.

### Logs
Cloudflare retains this worker's logs for 7 days. They record the sender, the
recipient, the message size, and whether an OTP or magic link was found —
**never the subject line, the body, or the code or link itself**. Subject lines
are left out because many services put the one-time code in them.

Cloudflare's own Email Routing activity log, in our Cloudflare dashboard,
separately lists each message's sender, recipient and subject line, so a code
that a service puts in its subject line does appear there.

Our dashboard host and Cloudflare also keep standard request logs (IP address,
user agent, request path) for up to 7 days.

### Retention
All inbox data is stored in Upstash Redis with a **30-minute TTL**. The email and
its expiry are written in a single atomic transaction, so a message cannot be
stored without its deletion timer. Each new message restarts its inbox's timer,
so an inbox and everything in it are deleted 30 minutes after its latest
message; while mail keeps arriving, earlier messages stay with it.

### Edge processing
Processing happens entirely inside the Cloudflare Worker at the edge — before any
data reaches Redis. The worker:
1. Validates the recipient address; malformed addresses are rejected
2. Rejects mail from a short list of platforms whose verification codes were
   being farmed through free inboxes
3. Checks the inbox's account prefix, if it has one (`k7x2-…`): mail to a
   suspended or deleted account's prefix is rejected, because the read API
   returns it to nobody; an active account's inboxes aren't counted in step 4
4. Applies a keyless allowance to mail for `zerodrop-sandbox.online`: 5
   different inboxes a day per sending domain (per address for consumer mailbox
   providers); a Workspace's own domain isn't counted. Mail past it is held: it isn't
   parsed or stored, and the inbox receives a short notice naming the sender's
   domain and how to get a free key
5. Extracts OTP codes and magic links from the plain-text body
6. Stores the message under `inbox:{name}` with a 1800s TTL, atomically

The allowance (4) ran in monitoring mode — logging what it would hold — from
October 13, 2026 while API keys rolled out, and is now enforced. If Redis can't
answer the checks in steps 3 and 4, the mail is stored rather than held or
rejected.

The worker source code is fully auditable:
→ https://github.com/zerodrop-dev/zerodrop-worker

### OTP and verification codes
OTPs and magic links are extracted at the edge using pattern matching on the
plain-text email body. Codes adjacent to a label ("code", "OTP", "verification
code", and similar) are preferred; a bare number is used only as a fallback, and
values that look like years, prices or percentages are skipped. They are stored
alongside the raw email payload in Redis and are deleted with the rest of the
inbox data. Extraction happens entirely within Cloudflare's
infrastructure — no external service is called, and the worker never writes
codes to its logs (see Logs).

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

## No AI Processing

ZeroDrop runs no AI model on your email. Earlier versions ran a Llama 3.1 spam
classifier on Cloudflare Workers AI, in monitoring mode, which saw each message's
sender and subject line but never the body. It was removed in October 2026.

---

## GitHub Action Security

The `zerodrop-dev/setup-zerodrop` Action generates inbox names **locally on the runner** — no network request is made during the generation step. The inbox address is a random string; it does not contact ZeroDrop servers until your tests begin polling.

### Supply chain hardening

Pin to a specific commit SHA rather than a floating tag:

```yaml
# Recommended for production
uses: zerodrop-dev/setup-zerodrop@aa882ace46b204bfd84bbcc374df73d32cf67343  # v1.1.0
```

### Action permissions
The Action requires no special GitHub permissions. It does not access `GITHUB_TOKEN`, repository contents, secrets, or any runner environment variables.

---

## Shared Domain Risk

The free tier routes email through a shared domain (`zerodrop-sandbox.online`). This domain is used by many developers for CI testing.

**Risk:** Shared sending domains can be flagged by disposable email detection libraries used by some identity providers (Auth0, Clerk, and similar). If your application rejects disposable email addresses, tests using the free tier sandbox domain will fail.

**Also worth knowing:** on the free tier, the inbox name *is* the access control.
Anyone who knows or guesses a name can read that inbox. Names are random and
generated client-side, and an inbox is deleted 30 minutes after its latest
message, but the free tier is not the right place for anything sensitive.

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
| Data persistence | Hard Redis TTL, written atomically with each message — an inbox is deleted 30 minutes after its latest message, regardless of application logic |
| Malformed recipient addresses | Validated at the worker and in the read API; only `[a-z0-9._+-]` names up to 64 characters are accepted |
| Supply chain attack via Action | SHA pinning documented; worker source is auditable |
| OTP theft | 30-min TTL limits exposure window; the worker never logs codes or subject lines; on the free tier they're accessible to whoever knows the inbox name |
| Spam and registration farming | Mail from platforms whose codes were being farmed is rejected outright. Without an API key, one sender can reach 5 different inboxes a day; mail past that is held and the inbox gets a notice instead; see Edge processing |
| Shared domain blocklist | Free tier risk documented; Workspaces use a domain dedicated to your team |

---

## Contact

- Security disclosures: security@zerodrop.dev
- General: zerodrop.dev
