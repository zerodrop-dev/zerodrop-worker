// ============================================
// SENDER AUTHENTICATION
// ============================================
// Cloudflare Email Routing checks SPF, DKIM and DMARC before the Worker runs
// and prepends its verdict as an Authentication-Results header whose
// authserv-id is mx.cloudflare.net. A sender can put a header of that name,
// with that authserv-id, anywhere in its own message, so only the one inside
// Cloudflare's own block at the top of the raw message counts. That block
// starts with Cloudflare's Received header, ends with its X-CF-SpamH-Score
// header, and holds only the header names Cloudflare adds (CLOUDFLARE_BLOCK);
// the sender's own headers all come after it.
//
// Anything else is "unknown", never a pass: no such block, a block that
// doesn't end with the score header, no result in it or more than one, a
// result that doesn't parse, or a DMARC pass for a domain other than the
// visible From's. Results are read from the raw message, not from
// message.headers, whose get() merges repeated headers into one string.
//
// result:
//   verified    DMARC passed for the visible From domain
//   unverified  the From domain publishes no DMARC policy (dmarc=none)
//   failed      DMARC failed
//   unknown     anything else

const CLOUDFLARE_AUTHSERV = "mx.cloudflare.net";
const CLOUDFLARE_BLOCK = new Set([
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
  "received-spf",
  "authentication-results",
  "x-cf-spamh-score",
]);
const MAX_BLOCK = 40; // headers scanned for the block's end

// The header section as [{ name, value }] in order: names lower-cased,
// folded lines joined.
export function headerFields(raw) {
  const text = String(raw || "");
  const end = text.search(/\r?\n\r?\n/);
  const head = end === -1 ? text : text.slice(0, end);
  const fields = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (fields.length) fields[fields.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return fields;
}

// Cloudflare's block, without its Received header, or null.
export function cloudflareBlock(fields) {
  if (!fields.length || fields[0].name !== "received" || !/cloudflare/i.test(fields[0].value)) return null;
  const block = [];
  for (let i = 1; i < fields.length && i <= MAX_BLOCK; i++) {
    const field = fields[i];
    if (!CLOUDFLARE_BLOCK.has(field.name)) return null; // a header Cloudflare doesn't add, before the end
    block.push(field);
    if (field.name === "x-cf-spamh-score") return block;
  }
  return null;
}

// Drops (comments), however nested, keeping "quoted strings" as they are:
// a comment such as "(dmarc=pass)" must never count as a result.
function stripComments(value) {
  let out = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const ch of String(value)) {
    if (escaped) {
      if (depth === 0) out += ch;
      escaped = false;
    } else if (ch === "\\") {
      if (depth === 0) out += ch;
      escaped = true;
    } else if (quoted) {
      out += ch;
      if (ch === '"') quoted = false;
    } else if (depth === 0 && ch === '"') {
      out += ch;
      quoted = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

// An Authentication-Results value (RFC 8601), or an ARC-Authentication-Results
// one with its "i=N;" instance tag: { authserv, methods: [{ method, result, props }] }.
export function parseAuthResults(value) {
  const parts = stripComments(value)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length && /^i\s*=\s*\d+$/i.test(parts[0])) parts.shift();
  if (!parts.length) return null;
  const authserv = parts.shift().split(/\s+/)[0].toLowerCase();
  const methods = [];
  for (const part of parts) {
    const m = /^([a-z][a-z0-9-]*)\s*=\s*([a-z]+)/i.exec(part);
    if (!m) continue;
    const props = {};
    for (const p of part.matchAll(/([a-z]+\.[a-z0-9._-]+)\s*=\s*("[^"]*"|[^\s;]+)/gi)) {
      props[p[1].toLowerCase()] = p[2].replace(/^"|"$/g, "");
    }
    methods.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props });
  }
  return { authserv, methods };
}

// A domain in its ASCII form: lower case, an internationalized name as
// xn--…, so a lookalike shows as what it is. Null if it isn't a host name.
export function asciiDomain(domain) {
  const d = String(domain || "").trim();
  if (!d || /[\s/\\?#@]/.test(d)) return null;
  try {
    return new URL(`http://${d}`).hostname.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

// The address in a From header, without its display name: quoted strings and
// comments go first, so a display name such as "<ceo@yourapp.com>" can't pass
// for the address. Null if there isn't one.
export function headerFromAddress(headerFrom) {
  const h = stripComments(String(headerFrom || "").replace(/"(?:[^"\\]|\\.)*"/g, ""));
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(h) || /([^\s<>",;:]+@[^\s<>",;:]+)/.exec(h);
  if (!m) return null;
  const at = m[1].lastIndexOf("@");
  const local = m[1].slice(0, at);
  const domain = asciiDomain(m[1].slice(at + 1));
  return local && domain ? `${local.toLowerCase()}@${domain}` : null;
}

// { result, dmarc, spf, dkim, fromDomain } for a raw message and its visible From.
export function authFromRaw(raw, headerFrom) {
  const fromDomain = headerFromAddress(headerFrom)?.split("@")[1] ?? null;
  const unknown = { result: "unknown", dmarc: null, spf: null, dkim: null, fromDomain };

  const block = cloudflareBlock(headerFields(raw));
  if (!block) return unknown;
  const ours = (name) =>
    block
      .filter((f) => f.name === name)
      .map((f) => parseAuthResults(f.value))
      .filter((r) => r && r.authserv === CLOUDFLARE_AUTHSERV);
  const results = ours("authentication-results");
  const arc = ours("arc-authentication-results");
  if (results.length !== 1 || arc.length > 1) return unknown;

  const methods = (r, name) => r.methods.filter((m) => m.method === name);
  const dmarcs = methods(results[0], "dmarc");
  if (dmarcs.length > 1) return unknown;
  const dmarc = dmarcs[0] ?? null;
  const spf = methods(results[0], "spf")[0]?.result ?? null;
  const dkims = methods(results[0], "dkim");
  const dkim = dkims.length === 0 ? null : dkims.some((m) => m.result === "pass") ? "pass" : dkims[0].result;

  // Cloudflare's ARC copy of its results, when it adds one, must agree.
  const arcDmarc = arc.length ? methods(arc[0], "dmarc")[0]?.result ?? null : null;
  if (arcDmarc && dmarc && arcDmarc !== dmarc.result) return unknown;

  let result = "unknown";
  if (dmarc?.result === "pass") {
    const passedFor = asciiDomain(dmarc.props["header.from"]);
    if (fromDomain && passedFor === fromDomain) result = "verified";
  } else if (dmarc?.result === "fail") {
    result = "failed";
  } else if (dmarc?.result === "none") {
    result = "unverified";
  }
  return { result, dmarc: dmarc?.result ?? null, spf, dkim, fromDomain };
}
