// ============================================
// ENCRYPTION AT REST
// ============================================
// With the INBOX_ENCRYPTION_KEY secret set, every email the Worker stores,
// held notices included, is encrypted with AES-256-GCM before it leaves the
// Worker. The read API holds the same key and decrypts. Without the secret
// (self-hosting, local development) emails are stored as plain JSON, as
// before. What the database still holds in the clear: inbox names (they are
// the Redis keys), the allowance counters, account and Workspace records, and
// any email stored before the key was set. An inbox that keeps receiving mail
// keeps such older emails, up to its newest 50, until it goes quiet for its
// retention.
//
// A stored item is "zd1:<key id>:<iv>:<ciphertext>", the last two in base64url
// without padding:
//   key id      the first 8 hex characters of the key's SHA-256. The read API
//               uses it to pick the current or the previous key while keys
//               are being rotated
//   iv          12 random bytes, new for every email
//   ciphertext  the email's JSON, encrypted, with GCM's 16-byte tag at the end
// The additional authenticated data is the item's header and the Redis key it
// is stored under ("zd1:<key id>:inbox:{name}"), so an item copied into
// another inbox, or relabelled with another key id or version, doesn't
// decrypt. Must match src/lib/inbox-crypto.js in the dashboard repo.
//
// The key is 32 random bytes, base64:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   npx wrangler secret put INBOX_ENCRYPTION_KEY
// The read API needs the same value, and must be deployed with it first: it
// reads both forms, so the Worker can switch over at any time after that.
//
// The Worker throws, and stores nothing, rather than store an email
// unencrypted when the key is set but doesn't decode to 32 bytes (an empty
// value included), or when INBOX_ENCRYPTION_REQUIRED is set and the key isn't:
//   npx wrangler secret put INBOX_ENCRYPTION_REQUIRED     then type: true
// (Any value but 0, false, no or off turns it on.) What the sending server is
// told when the Worker throws is in the email handler's comments, in index.js.

export const SEALED_VERSION = "zd1";

const encoder = new TextEncoder();

// Buffer (from the nodejs_compat flag in wrangler.jsonc) converts base64 about
// 50 times faster than btoa and atob, which matters for large emails on the
// Worker's CPU budget. The btoa/atob paths are the fallback.
const NodeBuffer = globalThis.Buffer;

let cached = null; // { secret, key, keyId } for the secret last seen

// Standard base64 or base64url, with or without padding. Returns null for
// anything else.
export function decodeBase64(text) {
  const normalized = String(text).trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(normalized) || normalized.length % 4 === 1) return null;
  if (NodeBuffer) {
    const b = NodeBuffer.from(normalized, "base64");
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  let binary;
  try {
    binary = atob(normalized + "===".slice((normalized.length + 3) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Without Buffer: in chunks, because String.fromCharCode with one argument per
// byte is many times faster than adding one character at a time, and chunking
// keeps the argument list within the engine's limits for large emails.
export function toBase64url(bytes) {
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function keyIdOf(rawKey) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawKey));
  return [...digest.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// INBOX_ENCRYPTION_REQUIRED: on for any value but an empty one, 0, false, no
// or off, so a value that's merely misspelt still protects.
export function encryptionRequired(env) {
  const value = String(env.INBOX_ENCRYPTION_REQUIRED ?? "").trim().toLowerCase();
  return value !== "" && !["0", "false", "no", "off"].includes(value);
}

async function encryptionKey(env) {
  const secret = env.INBOX_ENCRYPTION_KEY;
  if (secret === undefined || secret === null) {
    if (encryptionRequired(env)) {
      throw new Error("INBOX_ENCRYPTION_REQUIRED is set but INBOX_ENCRYPTION_KEY isn't");
    }
    return null;
  }
  if (cached && cached.secret === secret) return cached;
  const raw = decodeBase64(secret);
  if (!raw || raw.length !== 32) {
    throw new Error("INBOX_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  cached = { secret, key, keyId: await keyIdOf(raw) };
  return cached;
}

// What goes into Redis for one email: its sealed form when the key is set,
// otherwise its JSON unchanged. `json` is the email's JSON; `redisKey` is the
// key it will be stored under.
export async function storedForm(env, redisKey, json) {
  const k = await encryptionKey(env);
  if (!k) return { item: json, encrypted: false };
  const header = `${SEALED_VERSION}:${k.keyId}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(`${header}:${redisKey}`) },
      k.key,
      encoder.encode(json)
    )
  );
  return {
    item: `${header}:${toBase64url(iv)}:${toBase64url(ciphertext)}`,
    encrypted: true,
  };
}
