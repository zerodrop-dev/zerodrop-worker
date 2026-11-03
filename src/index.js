import { storedForm } from "./encryption.js";

// Inbox names come from the recipient's local part, which the SENDER controls.
// Accept only what real inboxes use: lowercase letters, digits, and . _ + -
// (64 = RFC 5321 local-part limit). Must match src/lib/inbox-name.js in the
// dashboard repo, so the read side and write side agree on what's valid.
const INBOX_NAME = /^[a-z0-9._+-]{1,64}$/;

function normalizeInboxName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.toLowerCase();
  if (!INBOX_NAME.test(name)) return null;
  if (name.includes("..")) return null;
  return name;
}

// ============================================
// OTP EXTRACTION
// ============================================
// Two passes, labelled first: a code next to a word like "code" or "OTP" beats
// a bare number anywhere in the body. The old single regex scanned left to
// right, so "(c) 2026" in a preheader won over the real code further down.
// The bare-number fallback runs only when a plain-text part was parsed (never
// against raw MIME, whose headers are full of digits) and skips values that
// are almost certainly not codes: years, and numbers next to a currency
// symbol or percent sign.
const OTP_LABELLED = /(?:one[\s-]?time(?:\s+(?:code|password|pin))?|verification\s+(?:code|pin)|security\s+code|access\s+code|confirmation\s+code|passcode|\botp\b|\bcode\b|\bpin\b)[^\d]{0,30}(\d{4,8})/i;
const OTP_BARE = /(?:^|[\s>])(\d{4,8})(?=[\s<.,!]|$)/gm;

function looksLikeYear(value) {
  if (value.length !== 4) return false;
  const n = Number(value);
  return n >= 1900 && n <= 2099;
}

function extractOtp(bodyText, plainTextParsed) {
  const labelled = OTP_LABELLED.exec(bodyText);
  if (labelled) return labelled[1];
  if (!plainTextParsed) return null;

  for (const m of bodyText.matchAll(OTP_BARE)) {
    const value = m[1];
    if (looksLikeYear(value)) continue;
    const before = bodyText.slice(Math.max(0, m.index - 12), m.index);
    const after = bodyText.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/[$£€₹¥]\s*$/.test(before)) continue;        // prices
    if (/©|\(c\)|copyright/i.test(before)) continue;  // footer years
    if (/^\s*%/.test(after)) continue;                // percentages
    return value;
  }
  return null;
}

// ============================================
// KEYLESS ALLOWANCE
// ============================================
// Without an API key, one sender can reach at most ALLOWANCE_PER_DAY distinct
// inboxes per UTC day. Farming needs a fresh inbox for every fake account, so
// it runs out at once; a developer testing their own app stays under it or
// gets a free key, and inboxes under a key's namespace (k7x2-...) aren't
// counted. Counted per sending domain, or per full address for consumer
// mailbox providers. Only mail to the shared sandbox domain is counted: a
// Workspace's own domain, or a self-hosted instance's, never is.
// Replaced the hourly cap (20 an hour, shadow mode) on
// Oct 13, 2026: farming spread thinly across hours never tripped it. It ran in
// shadow mode from then while API keys rolled out, and is now enforced.
//
// The optional ALLOWANCE_MODE secret overrides the mode without a code change:
//   unset     — enforce: mail past the allowance is held. It is neither parsed
//               nor stored, and the inbox gets a notice in its place
//   "shadow"  — count and log "would hold", but store the email anyway (the
//               rollback switch)
//   "off"     — don't count at all
//   npx wrangler secret put ALLOWANCE_MODE       then type: shadow
//   npx wrangler secret delete ALLOWANCE_MODE    back to enforce
const ALLOWANCE_PER_DAY = 5;
const SANDBOX_DOMAIN = "zerodrop-sandbox.online";

function allowanceMode(env) {
  const mode = String(env.ALLOWANCE_MODE || "").trim().toLowerCase();
  return mode === "shadow" || mode === "off" ? mode : "enforce";
}

// Counting runs as one Lua script, so the check and the add are atomic: mail
// arriving at the same moment can't all see room under the allowance and all
// get in. KEYS[1] is the sender's set of inboxes for the day (expires after 2
// days); ARGV[1] the inbox, ARGV[2] the allowance, ARGV[3] "1" to admit mail
// past it anyway (shadow mode). Returns {status, inboxes the sender reached
// today before this one}:
//    0  an inbox the sender already reached today: admitted
//    1  a new inbox within the allowance: admitted and counted
//    2  past the allowance, admitted anyway (shadow)
//   -1  past the allowance: hold. A held inbox doesn't join the set
const COUNT_SCRIPT = `
local n = redis.call('SCARD', KEYS[1])
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return {0, n} end
local over = n >= tonumber(ARGV[2])
if over and ARGV[3] ~= '1' then return {-1, n} end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], 172800)
if over then return {2, n} end
return {1, n}
`;

// Senders exempt from the allowance (the grace period for integrations that
// predate API keys) come from the CAP_ALLOWLIST secret: comma-separated parent
// domains. The list is never written here, because this repo is public and it
// names customers. The optional ALLOWLIST_UNTIL secret (YYYY-MM-DD) ends the
// exemption automatically after that UTC date.
//   npx wrangler secret put CAP_ALLOWLIST
//   npx wrangler secret put ALLOWLIST_UNTIL
// Consumer mailbox domains (gmail.com, posteo.com, ...) don't belong in it:
// allowlisting one would exempt everyone who uses that provider.
function domainSet(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean)
  );
}

function allowlisted(env, domain) {
  if (!domain) return false;
  const until = String(env.ALLOWLIST_UNTIL || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(until) && new Date().toISOString().slice(0, 10) > until) {
    return false;
  }
  return domainSet(env.CAP_ALLOWLIST).has(domain);
}

// ============================================
// ACCOUNT NAMESPACES
// ============================================
// A free API key such as zd_k7x2_... makes the SDKs name inboxes
// k7x2-swift-x7k29ab. A namespace is 4 characters with at least one letter and
// one digit, so it never matches the adjective prefixes (dark-, void-, ...)
// that names get without a key. The dashboard registers each namespace as
// ns:{namespace} in Redis, holding the account id (a UUID) while the account
// is active, "suspended" while it's suspended and "retired" once it's deleted
// (src/lib/accounts.js in the dashboard repo). Who may READ an inbox is
// enforced by the read API; here the value decides what happens to the mail:
//   no value    — no account: counted like any keyless inbox
//   account id  — a known account's inbox: stored, not counted
//   other       — suspended or retired: rejected. The read API returns such
//                 inboxes to nobody, so storing the mail would only keep
//                 unreadable mail for 30 minutes
const NAMESPACE_PREFIX = /^([a-z0-9]{4})-/;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function namespaceOf(inboxName) {
  const m = NAMESPACE_PREFIX.exec(inboxName);
  if (!m) return null;
  const ns = m[1];
  return /[a-z]/.test(ns) && /[0-9]/.test(ns) ? ns : null;
}

// "unregistered", "active" or "closed", from the raw value of ns:{namespace}.
function namespaceState(value) {
  if (!value) return "unregistered";
  return typeof value === "string" && ACCOUNT_ID.test(value) ? "active" : "closed";
}

function isNamespace(value) {
  return typeof value === "string" && /^[a-z0-9]{4}$/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
}

// ============================================
// WORKSPACES: CUSTOM DOMAINS AND RETENTION
// ============================================
// A Workspace is an account with its own receiving domain, its own retention,
// or both. They're set by hand with scripts/workspace.mjs in the dashboard
// repo, which keeps them in Redis:
//   domain:{domain}   the namespace of the account that receives the domain's
//                     mail. The domain is a zone in the Cloudflare account this
//                     Worker runs in, with a catch-all rule that sends to it.
//                     A domain that's been taken away keeps the value
//                     "removed:{namespace}" (or "removed"), so mail still
//                     routed to it is rejected rather than stored like an
//                     unregistered domain's
//   ttl:{namespace}   how long the account's inboxes are kept after their
//                     latest email, in seconds. Without it, 30 minutes
// The domain in the key is in canonical form (canonicalDomain below), the
// form the script writes, so every way of writing the recipient's domain
// finds the same record.
//
// Mail to a Workspace domain is filed under the owner's namespace, so it can
// be read only with the owner's key, like the account's inboxes on the shared
// domain: swift-x7k29ab@qa.example goes to inbox k7x2-swift-x7k29ab, and
// k7x2-swift-x7k29ab@qa.example stays as it is. A local part that starts with
// another account's namespace is filed under the owner's too (k7x2-ab12-...),
// never under the other account's. The domain isn't part of the inbox name,
// so x@ on each of an account's domains and k7x2-x on the shared domain all
// share the inbox k7x2-x. Workspace mail isn't counted against the keyless
// allowance, which protects the shared domain: a Workspace's mail is its
// owner's. The sender blocklist applies to it all the same, because it
// protects the platforms on it, whatever domain their mail is sent to.
// Workspace mail is stored only once its owner's account is confirmed active:
// under a namespace with no account, the read API would show it to anyone.
//
// Mail to a domain that isn't registered depends on the DOMAIN_MODE secret:
//   unset, "strict"  rejected: only the shared domain and Workspace domains
//                    receive mail, so a zone routed here before it's
//                    registered or after it's removed, or a subdomain of a
//                    Workspace's domain, can't fill inboxes anyone can read.
//                    Any value but "open" is strict
//   "open"           stored by its local part, as before Workspaces. A
//                    self-hosted Worker on its own domain needs this:
//   npx wrangler secret put DOMAIN_MODE       then type: open
const DEFAULT_TTL = 1800;
const MIN_TTL = 60;
const MAX_TTL = 7 * 24 * 60 * 60;

// Seconds, from the raw value of ttl:{namespace}: only a plain whole number
// counts, held within MIN_TTL..MAX_TTL; anything else means the default. Must
// match retentionSeconds() in the dashboard's src/lib/workspaces.js.
function retentionSeconds(value) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,9}$/.test(text) || Number(text) === 0) return DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, Number(text)));
}

function strictDomains(env) {
  return String(env.DOMAIN_MODE ?? "").trim().toLowerCase() !== "open";
}

// The recipient's domain in the one form domain:{domain} keys use: lowercase
// ASCII, an internationalized name in its xn-- form, no trailing dot. The
// sender writes the envelope recipient, so QA.Example., qa。example,
// full-width letters and the Unicode form of an IDN must all reach the record
// for qa.example (or its xn-- form); URL's host parser maps them, as browsers
// do. Null when the result isn't a plain host name.
function canonicalDomain(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /[\s\/\\?#:@[\]%]/.test(text)) return null;
  let host;
  try {
    host = new URL(`http://${text}/`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, "");
  return HOST_NAME.test(host) ? host : null;
}

// The inbox for mail to a Workspace domain, or null if the name can't take the
// owner's prefix within the 64-character limit.
function workspaceInbox(ns, inboxName) {
  const name = inboxName.startsWith(`${ns}-`) ? inboxName : `${ns}-${inboxName}`;
  return name.length <= 64 ? name : null;
}

// What a held inbox receives instead of the email, so a test that waits for
// mail fails with the reason rather than a timeout. Names the sender's domain,
// never anything from the held message: for consumer mailbox providers, where
// the allowance counts per address, it says "an address at gmail.com" rather
// than the address. `held: true` marks it for the clients, which stop waiting
// and raise an error carrying `reason`, the same text on one line.
//
// The domain comes from the From header, which the sender writes, so it is
// named only when it is a plain host name. Otherwise a header such as
// <a@x.https://evil.example/keys> would put "https://evil.example/keys" into
// every client's error message.
const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function noticePayload(to, domain, perAddress) {
  const named = HOST_NAME.test(domain || "") ? domain : null;
  const sender = named ? (perAddress ? `an address at ${named}` : named) : "this sender";
  const paragraphs = [
    `ZeroDrop held an email from ${sender} to this inbox. The email was not stored.`,
    `Without an API key, one sender can reach ${ALLOWANCE_PER_DAY} different inboxes a day, ` +
      `and this sender reached that today.`,
    `Get a free key at https://zerodrop.dev/keys and set it as ZERODROP_API_KEY. ZeroDrop's ` +
      `clients then start new inbox names with your key's prefix, and mail to those inboxes ` +
      `isn't limited.`,
  ];
  const text = `${paragraphs.join("\n\n")}\n`;
  const subject = "ZeroDrop held an email: daily limit without an API key";
  return {
    id: crypto.randomUUID(),
    from: "notice@zerodrop.dev",
    to,
    subject,
    receivedAt: new Date().toISOString(),
    raw:
      `From: ZeroDrop <notice@zerodrop.dev>\r\nTo: ${to}\r\nSubject: ${subject}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n${text.replace(/\n/g, "\r\n")}`,
    otp: null,
    magicLink: null,
    held: true,
    reason: paragraphs.join(" "),
  };
}

// Collapse subdomains to the parent: sc.mail.deepseek.com -> deepseek.com,
// mail.example.co.uk -> example.co.uk. Heuristic, not a full public-suffix list.
const MULTI_PART_SLD = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);
function parentDomain(host) {
  const labels = String(host).toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && MULTI_PART_SLD.has(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

// Consumer mailbox providers are shared by millions of unrelated people, so
// for them the allowance counts per full sender ADDRESS, not per domain: one
// person reaching 6 inboxes a day is still counted; 1,000 Gmail users sending
// one email each never collide.
const CONSUMER_MAILBOX = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me",
  "protonmail.com", "posteo.com", "gmx.com", "gmx.de", "zoho.com",
]);

// Key on the header From domain, not the envelope sender: ESP customers
// share envelope domains (amazonses.com, sendgrid.net) and must not share
// one counter. Falls back to the envelope if the header can't be parsed.
function senderAddress(headerFrom, envelopeFrom) {
  const h = headerFrom || "";
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(h) || /([^\s<>"]+@[^\s<>"]+)/.exec(h);
  return ((m ? m[1] : envelopeFrom) || "").toLowerCase();
}

// Returns { domain, identity }: domain for the allowlist and blocklist,
// identity for the allowance counter (the full address for consumer
// mailboxes, else the domain).
function capIdentity(headerFrom, envelopeFrom) {
  const addr = senderAddress(headerFrom, envelopeFrom);
  const domain = parentDomain(addr.split("@").pop());
  return { domain, identity: CONSUMER_MAILBOX.has(domain) ? addr : domain };
}

// ============================================
// SENDER BLOCKLIST
// ============================================
// Platforms whose verification codes were being farmed through free inboxes:
// one fresh inbox per signup, spread thinly enough that the hourly cap never
// saw a burst. OpenAI's were farmed by an automated ChatGPT registration run
// in August 2026. Nobody testing their own app needs mail from these senders,
// so it is rejected outright, on the shared domain and on Workspace domains
// alike. Matched on the parent domain of the header From, so
// sc.mail.deepseek.com counts as deepseek.com. Public on purpose: what we
// refuse can be public; who we exempt cannot.
const SENDER_BLOCKLIST = new Set([
  "deepseek.com",
  "eazo.ai",
  "miraimindjp.com",
  "openai.com",
  "platoapp.com",
  "reddit.com",
  "runbios.ai",
  "superprofile.bio",
  "x.ai",
]);

export default {
  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;
    const subject = message.headers.get("subject") || "(no subject)";
    const messageId = message.headers.get("message-id") || crypto.randomUUID();

    let inboxName = normalizeInboxName(to.split("@")[0]);
    if (!inboxName) {
      console.log(`[ZeroDrop] Rejected invalid recipient local part from ${from}`);
      message.setReject("Invalid recipient");
      return;
    }
    const recipientDomain = canonicalDomain(String(to).split("@").pop());
    if (!recipientDomain) {
      console.log(`[ZeroDrop] Rejected invalid recipient domain from ${from}`);
      message.setReject("Invalid recipient");
      return;
    }
    const toSandbox = recipientDomain === SANDBOX_DOMAIN;

    // ============================================
    // WORKSPACE DOMAIN
    // ============================================
    // Mail to any domain but the shared one may be a Workspace's (see
    // WORKSPACES above). If Redis can't say, the handler throws and nothing
    // is stored: a Workspace's mail must never land outside its owner's
    // namespace. Cloudflare's documentation doesn't say what the sending
    // server is told when an Email Worker throws (a temporary failure it
    // retries, or a bounce), so such mail may not arrive later.
    let workspace = null;
    if (!toSandbox) {
      let owner;
      try {
        [owner] = await redis(env, "/pipeline", [["GET", `domain:${recipientDomain}`]]);
      } catch (lookupError) {
        console.log(`[ZeroDrop] Domain lookup failed, nothing stored: ${lookupError.message}`);
        throw lookupError;
      }
      if (owner == null) {
        if (strictDomains(env)) {
          console.log(`[ZeroDrop] Rejected mail to unregistered domain ${recipientDomain} from ${from} (DOMAIN_MODE=open would store it)`);
          message.setReject("Unknown recipient domain");
          return;
        }
      } else if (!isNamespace(owner)) {
        console.log(`[ZeroDrop] Rejected mail to a closed Workspace domain from ${from}`);
        message.setReject("This inbox is closed");
        return;
      } else {
        const name = workspaceInbox(owner, inboxName);
        if (!name) {
          console.log(`[ZeroDrop] Rejected a Workspace recipient too long for its prefix ns=${owner} from ${from}`);
          message.setReject("Invalid recipient");
          return;
        }
        workspace = owner;
        inboxName = name;
      }
    }

    const { domain, identity } = capIdentity(message.headers.get("from"), from);

    // ============================================
    // SENDER BLOCKLIST CHECK
    // ============================================
    if (SENDER_BLOCKLIST.has(domain)) {
      console.log(`[ZeroDrop] Blocked sender=${domain} inbox=${inboxName}`);
      message.setReject("Mail from this sender is not accepted");
      return;
    }

    // ============================================
    // ACCOUNT PREFIX AND KEYLESS ALLOWANCE CHECK
    // ============================================
    // First, for a prefixed name, what ns:{namespace} and ttl:{namespace}
    // hold: an active account's inbox isn't counted and keeps the account's
    // retention, and a closed one's mail is rejected, as is a Workspace
    // domain's mail for an account that doesn't exist. Then, if the mail
    // counts against the allowance, the count script (COUNT_SCRIPT) admits the
    // inbox or says to hold it. Fails open on the shared domain: if Redis
    // can't answer, the email is stored with 30 minutes (which never shortens
    // an inbox already kept longer: see STORE) and nothing is held or
    // rejected. A Workspace's mail fails closed: the handler throws and
    // nothing is stored, as for the domain lookup above.
    const mode = allowanceMode(env);
    const ns = namespaceOf(inboxName);
    let allowKey =
      mode !== "off" && toSandbox && domain && !allowlisted(env, domain)
        ? `allow:${identity}:${new Date().toISOString().slice(0, 10)}`
        : null;
    let held = false;
    let closed = false;
    let ttl = DEFAULT_TTL;
    try {
      if (ns) {
        const [owner, retention] = await redis(env, "/pipeline", [["GET", `ns:${ns}`], ["GET", `ttl:${ns}`]]);
        const state = namespaceState(owner);
        closed = state === "closed" || (workspace !== null && state === "unregistered");
        if (state === "active") ttl = retentionSeconds(retention);
        if (state !== "unregistered") allowKey = null; // an account's inbox: not counted
      }
      if (allowKey) {
        const [[status, before]] = await redis(env, "/pipeline", [
          ["EVAL", COUNT_SCRIPT, "1", allowKey, inboxName, String(ALLOWANCE_PER_DAY), mode === "shadow" ? "1" : "0"],
        ]);
        if (![-1, 0, 1, 2].includes(status)) throw new Error("unexpected reply from the count script");
        if (status === -1) {
          held = true;
          console.log(`[ZeroDrop] Held sender=${identity} inbox=${inboxName} distinct_today=${before}`);
        } else if (status === 2) {
          console.log(`[ZeroDrop] Allowance would hold (shadow) sender=${identity} inbox=${inboxName} distinct_today=${before}`);
        }
      }
    } catch (checkError) {
      if (workspace) {
        console.log(`[ZeroDrop] Account check failed for a Workspace domain ns=${workspace}, nothing stored: ${checkError.message}`);
        throw checkError;
      }
      console.log(`[ZeroDrop] Allowance check error — allowing email through: ${checkError.message}`);
    }

    if (closed) {
      console.log(`[ZeroDrop] Rejected mail to a closed prefix ns=${ns} sender=${domain}`);
      message.setReject("This inbox is closed");
      return;
    }

    if (held) {
      // The email itself is never parsed or stored; the inbox gets the notice.
      await store(env, inboxName, noticePayload(to, domain, identity !== domain));
      return;
    }

    // There is no content-based spam filter. A Workers AI classifier ran here
    // in monitoring mode until October 2026 and was removed: it flagged real
    // test mail as spam and missed most farmed codes. Abuse is handled by who
    // sends the mail (the blocklist) and how widely (the allowance), not by
    // what it says.

    // ============================================
    // PARSE EMAIL
    // ============================================
    const rawEmail = await new Response(message.raw).text();

    // ============================================
    // OTP + MAGIC LINK EXTRACTION
    // Extracted at the edge so SDK and Action
    // can expose them as first-class fields
    // ============================================

    // Extract plain text body for parsing
    const plainMatch = rawEmail.match(
      /Content-Type: text\/plain[^\r\n]*\r\n(?:Content-Transfer-Encoding:[^\r\n]*\r\n)?\r\n([\s\S]*?)(?:\r\n--|\r\n\r\n--)/
    );
    const bodyText = plainMatch
      ? plainMatch[1].replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).trim()
      : rawEmail;

    // Magic link — first https URL containing common auth path segments
    const magicLinkMatch = bodyText.match(
      /https?:\/\/[^\s<>"]+(?:verify|confirm|reset|magic|token|activate|auth)[^\s<>"']*/i
    );
    const magicLink = magicLinkMatch ? magicLinkMatch[0].replace(/[.,;!?)]+$/, "") : null;

    // OTP — labelled codes first, then a guarded bare-number fallback
    const otp = extractOtp(bodyText, Boolean(plainMatch));

    // Log presence only — never the code itself. Worker logs are retained for
    // 7 days; one-time codes must not outlive their inbox.
    console.log(`[ZeroDrop] Extracted — otp: ${otp ? "found" : "none"}, magicLink: ${magicLink ? "found" : "none"}`);

    // ============================================
    // BUILD EMAIL PAYLOAD
    // ============================================
    const emailPayload = {
      id: messageId,
      from,
      to,
      subject,
      receivedAt: new Date().toISOString(),
      raw: rawEmail,
      otp,
      magicLink,
    };

    const encrypted = await store(env, inboxName, emailPayload, ttl);
    console.log(`[ZeroDrop] Email from ${from} → inbox:${inboxName} encrypted=${encrypted ? "yes" : "no"}`);
  },
};

// ============================================
// REDIS — Upstash's REST API
// ============================================
// Commands go in the request BODY, so the inbox name never becomes part of a
// URL. Returns each command's result, or throws if the request or any command
// failed.
async function redis(env, path, commands) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  const replies = await response.json();
  if (!Array.isArray(replies) || replies.length !== commands.length || replies.some((r) => !r || r.error)) {
    throw new Error(`unexpected reply from Redis (HTTP ${response.status})`);
  }
  return replies.map((r) => r.result);
}

// ============================================
// STORE — one script, so it's atomic
// ============================================
// Adds the email to the front of its inbox, keeps the newest MAX_EMAILS, and
// sets the inbox to expire `ttl` seconds from now unless it's already set to
// last longer. A script runs atomically, so an email is never stored without
// an expiry, which is what makes the retention promise hold (30 minutes, or a
// Workspace's own). And an email never shortens its inbox's life: mail stored
// with the default 30 minutes because the account check failed can't cut
// short older mail in an inbox its account keeps for days. (Lowering an
// account's retention therefore applies to inboxes as they're created: one
// already kept longer runs out its time.)
//
// Each inbox keeps its newest MAX_EMAILS emails. The read API returns the
// whole list, and a fixed address with a retention of days would otherwise
// grow one list without bound.
//
// KEYS[1] the inbox; ARGV[1] the stored value; ARGV[2] the TTL in seconds;
// ARGV[3] the index of the last email kept. The stored value is an
// array-wrapped string: the email's JSON, or with INBOX_ENCRYPTION_KEY set,
// its encrypted form (encryption.js). Both read routes accept either.
const MAX_EMAILS = 50;
const STORE_SCRIPT = `
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, ARGV[3])
if redis.call('TTL', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

// Returns whether the email was encrypted.
async function store(env, inboxName, payload, ttl = DEFAULT_TTL) {
  const key = `inbox:${inboxName}`;
  const { item, encrypted } = await storedForm(env, key, JSON.stringify(payload));
  await redis(env, "/pipeline", [
    ["EVAL", STORE_SCRIPT, "1", key, JSON.stringify([item]), String(ttl), String(MAX_EMAILS - 1)],
  ]);
  return encrypted;
}
