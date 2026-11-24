// ============================================
// MIME PARSING (postal-mime), with MIME_PARSER=on
// ============================================
// The whole message is parsed: text and HTML come out decoded, whatever their
// transfer encoding, charset or header layout, and every link is collected
// with the words it's shown with. The magic link is then the one the email
// presents as its action (its button or anchor text), not the first URL with
// a keyword in it, so click-tracked links and HTML-only mail work, and an
// unsubscribe link never wins.
//
// Off unless MIME_PARSER is "on": on Workers Free, the parse can take the
// handler past the 10 ms CPU limit (SELF_HOSTING.md). Without it, or for a
// message parseMime() skips, the regex path in index.js runs.
import PostalMime from "postal-mime";

// Larger messages keep the regex path and are stored with parsed: false. The
// parser holds the whole message in memory, and decoding a big attachment
// costs tens of milliseconds of CPU.
export const PARSE_MAX_BYTES = 256 * 1024;
export const TEXT_MAX = 20000; // characters of text stored with the email
export const LINKS_MAX = 100;
export const LINK_TEXT_MAX = 200;
export const URL_MAX = 4000;
export const ATTACHMENTS_MAX = 20;

// Tighter than postal-mime's defaults, which are sized for any mail: an auth
// email has a handful of parts and forwards nothing.
const PARSER_LIMITS = {
  maxNestingDepth: 32,
  maxHeadersSize: 256 * 1024,
  maxPartCount: 200,
  maxRfc822NestingDepth: 2,
  maxForwardedAddresses: 200,
};

export function mimeParserOn(env) {
  return String(env.MIME_PARSER || "").trim().toLowerCase() === "on";
}

// The parts of a message the Worker uses, or null when it's over
// PARSE_MAX_BYTES or the parser refuses it (a resource limit), so the caller
// falls back to the regex path.
//   text         the plain-text part, or text made from the HTML part
//   plainPart    whether text came from a plain-text part (see extractOtp)
//   links        every http(s) link, in order, as { url, text }
//   attachments  { filename, mimeType, size } for each, never the content
//   listUnsubscribe  the List-Unsubscribe header, for chooseMagicLink()
export async function parseMime(rawBytes) {
  if (!rawBytes || rawBytes.byteLength > PARSE_MAX_BYTES) return null;
  let email;
  try {
    email = await PostalMime.parse(rawBytes, PARSER_LIMITS);
  } catch {
    return null;
  }
  const html = typeof email.html === "string" ? email.html : "";
  const plainPart = typeof email.text === "string";
  const plain = plainPart ? email.text : "";
  return {
    text: (plainPart ? plain : htmlToText(html)).trim().slice(0, TEXT_MAX),
    plainPart,
    links: collectLinks(html, plain),
    attachments: (email.attachments || []).slice(0, ATTACHMENTS_MAX).map((a) => ({
      filename: typeof a.filename === "string" ? a.filename : null,
      mimeType: typeof a.mimeType === "string" ? a.mimeType : null,
      size: typeof a.content === "string" ? a.content.length : (a.content?.byteLength ?? 0),
    })),
    listUnsubscribe: (email.headers || [])
      .filter((h) => h.key === "list-unsubscribe")
      .map((h) => h.value)
      .join(" "),
  };
}

// ============================================
// LINKS
// ============================================

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i;
const ALT = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const TEXT_URL = /https?:\/\/[^\s<>"']+/gi;

// Every http(s) link: the HTML part's anchors first, each with its visible
// text (or an image's alt text), then URLs written out in the plain-text part.
// One entry per URL, the first text that names it kept.
export function collectLinks(html, plain) {
  const links = [];
  const byUrl = new Map();
  const add = (url, text) => {
    if (!url) return;
    const known = byUrl.get(url);
    if (known) {
      if (!known.text && text) known.text = text;
      return;
    }
    if (links.length >= LINKS_MAX) return;
    const link = { url, text };
    byUrl.set(url, link);
    links.push(link);
  };
  for (const m of stripNonContent(html || "").matchAll(ANCHOR)) {
    const href = HREF.exec(m[1]);
    if (!href) continue;
    const url = httpUrl(decodeEntities(href[1] ?? href[2] ?? href[3]));
    if (!url) continue;
    let text = squash(decodeEntities(m[2].replace(/<[^>]*>/g, " ")));
    if (!text) {
      const alt = ALT.exec(m[2]);
      if (alt) text = squash(decodeEntities(alt[1] ?? alt[2]));
    }
    add(url, text.slice(0, LINK_TEXT_MAX));
  }
  for (const m of (plain || "").matchAll(TEXT_URL)) {
    add(httpUrl(m[0].replace(/[.,;!?)\]]+$/, "")), "");
  }
  return links;
}

// The words a verification button or link says, strongest first; then, for a
// link with no telling words, an auth word in its URL (the regex path's rule).
const ACTION_TEXT = /\b(verify|verification|confirm|activate|activation|reset|magic)\b/i;
const SIGN_IN_TEXT = /\b(sign[\s-]?in|log[\s-]?in)\b/i;
const AUTH_URL = /verify|confirm|reset|magic|token|activate|auth/i;
const UNSUBSCRIBE = /unsubscribe|opt[\s_-]?out|preference|email[\s_-]?settings|manage[\s_-]?(subscription|notification|email)/i;

// The magic link and where it came from: "anchor" (its words), "url" (an auth
// word in the URL) or "none". Unsubscribe and preference links, and any URL in
// the List-Unsubscribe header, never count.
export function chooseMagicLink(links, listUnsubscribe = "") {
  const listed = new Set(String(listUnsubscribe).match(/https?:\/\/[^\s<>,]+/gi) || []);
  const usable = links.filter((l) => !listed.has(l.url) && !UNSUBSCRIBE.test(l.url) && !UNSUBSCRIBE.test(l.text));
  const byText = usable.find((l) => ACTION_TEXT.test(l.text)) || usable.find((l) => SIGN_IN_TEXT.test(l.text));
  if (byText) return { url: byText.url, source: "anchor" };
  const byUrl = usable.find((l) => AUTH_URL.test(l.url.replace(/^https?:\/\//i, "")));
  return byUrl ? { url: byUrl.url, source: "url" } : { url: null, source: "none" };
}

// ============================================
// TEXT
// ============================================

// Comments (Outlook's conditional ones included), scripts and styles hold no
// text and no links a reader sees.
function stripNonContent(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

// Readable text from an HTML-only email: block ends become line breaks, tags
// go, entities are decoded.
export function htmlToText(html) {
  if (!html) return "";
  const text = stripNonContent(html)
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function squash(value) {
  return value.replace(/\s+/g, " ").trim();
}

// An absolute http(s) URL as written (tabs and line breaks dropped, as
// browsers drop them), or null.
function httpUrl(value) {
  const url = String(value ?? "").replace(/[\t\n\r]/g, "").trim();
  if (!/^https?:\/\/[^/]/i.test(url) || url.length > URL_MAX) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}
