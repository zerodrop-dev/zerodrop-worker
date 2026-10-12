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
// mailbox providers. Replaced the hourly cap (20 an hour, shadow mode) on
// Oct 13, 2026: farming spread thinly across hours never tripped it.
//   "shadow"  — count and log "would hold", store the email anyway (current)
//   "enforce" — hold mail past the allowance: store a notice in its place
const ALLOWANCE_MODE = "shadow";
const ALLOWANCE_PER_DAY = 5;

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
// ns:{namespace} in Redis. Mail to a registered namespace belongs to a known
// account and isn't counted against the allowance; who may READ it is enforced
// by the read API.
const NAMESPACE_PREFIX = /^([a-z0-9]{4})-/;

function namespaceOf(inboxName) {
  const m = NAMESPACE_PREFIX.exec(inboxName);
  if (!m) return null;
  const ns = m[1];
  return /[a-z]/.test(ns) && /[0-9]/.test(ns) ? ns : null;
}

// What a held inbox receives instead of the email, so a test that waits for
// mail fails with the reason rather than a timeout. Names the sender's domain,
// never anything from the held message.
function noticePayload(to, domain) {
  const text =
    `ZeroDrop held an email from ${domain || "this sender"} to this inbox.\n\n` +
    `Without an API key, one sender can reach ${ALLOWANCE_PER_DAY} different inboxes a day, ` +
    `and this sender passed that today. Get a free key at https://zerodrop.dev/keys and set ` +
    `ZERODROP_API_KEY: inboxes created with a key aren't limited.\n`;
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
// saw a burst. Nobody testing their own app needs mail from these senders, so
// it is rejected outright. Matched on the parent domain of the header From,
// so sc.mail.deepseek.com counts as deepseek.com. Public on purpose: what we
// refuse can be public; who we exempt cannot.
const SENDER_BLOCKLIST = new Set([
  "deepseek.com",
  "eazo.ai",
  "miraimindjp.com",
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

    const inboxName = normalizeInboxName(to.split("@")[0]);
    if (!inboxName) {
      console.log(`[ZeroDrop] Rejected invalid recipient local part from ${from}`);
      message.setReject("Invalid recipient");
      return;
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
    // KEYLESS ALLOWANCE CHECK
    // ============================================
    // One round trip: is the inbox under a registered namespace, and how many
    // distinct inboxes has this sender reached today? allowKey stays set only
    // when the mail counts against the allowance; the inbox joins the day's
    // set in the same transaction that stores the email, so the set holds
    // admitted inboxes only. Fails open on Redis errors.
    const ns = namespaceOf(inboxName);
    let allowKey =
      domain && !allowlisted(env, domain)
        ? `allow:${identity}:${new Date().toISOString().slice(0, 10)}`
        : null;
    let held = false;
    if (ns || allowKey) {
      try {
        const commands = [];
        if (ns) commands.push(["EXISTS", `ns:${ns}`]);
        if (allowKey) commands.push(["SISMEMBER", allowKey, inboxName], ["SCARD", allowKey]);
        const checkRes = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(commands),
        });
        const results = await checkRes.json();
        let i = 0;
        const registered = ns ? results[i++]?.result === 1 : false;
        if (registered) {
          allowKey = null; // a known account's inbox: not counted
        } else if (allowKey) {
          const known = results[i]?.result === 1;
          const count = Number(results[i + 1]?.result ?? 0);
          if (!known && count >= ALLOWANCE_PER_DAY) {
            if (ALLOWANCE_MODE === "enforce") {
              held = true;
              console.log(`[ZeroDrop] Held sender=${identity} inbox=${inboxName} distinct_today=${count}`);
            } else {
              console.log(`[ZeroDrop] Allowance would hold (shadow) sender=${identity} inbox=${inboxName} distinct_today=${count}`);
            }
          }
        }
      } catch (checkError) {
        console.log(`[ZeroDrop] Allowance check error — allowing email through: ${checkError.message}`);
      }
    }

    if (held) {
      // The email itself is never parsed or stored; the inbox gets the notice.
      await store(env, inboxName, noticePayload(to, domain), null);
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
    // 7 days; one-time codes must not outlive the 30-minute inbox TTL.
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

    await store(env, inboxName, emailPayload, allowKey);
    console.log(`[ZeroDrop] Email from ${from} → inbox:${inboxName}`);
  },
};

// ============================================
// STORE — one atomic transaction
// ============================================
// Commands go in the request BODY, so the inbox name never becomes part of a
// URL. /multi-exec is atomic: the email can't be stored without its TTL, which
// is what makes the 30-minute retention promise hold. The stored value is an
// array-wrapped JSON string, as before, so both read routes parse it
// unchanged. With allowKey, the inbox joins the sender's set for the day in
// the same transaction (a 2-day TTL covers the whole UTC day).
async function store(env, inboxName, payload, allowKey) {
  const key = `inbox:${inboxName}`;
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/multi-exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["LPUSH", key, JSON.stringify([JSON.stringify(payload)])],
      ["EXPIRE", key, "1800"],
      ...(allowKey ? [["SADD", allowKey, inboxName], ["EXPIRE", allowKey, "172800"]] : []),
    ]),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to store email: ${error}`);
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.some((r) => r && r.error)) {
    throw new Error(`Redis transaction error: ${JSON.stringify(results)}`);
  }
}
