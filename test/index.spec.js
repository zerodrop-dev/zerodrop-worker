import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Only fengari's core and base library: its full library set needs Node APIs
// that the Workers runtime doesn't have.
import * as lua from "fengari/src/lua.js";
import * as lauxlib from "fengari/src/lauxlib.js";
import { luaopen_base } from "fengari/src/lbaselib.js";
import { to_luastring } from "fengari/src/fengaricore.js";
import worker from "../src";
import { decodeBase64, toBase64url } from "../src/encryption.js";

// The email handler, run against an in-memory stand-in for Upstash's REST API
// (/pipeline, with the commands the worker sends). EVAL runs the worker's
// actual Lua scripts, in fengari (Lua 5.3; Redis runs 5.1, which behaves the
// same for everything the count and store scripts use).

// Runs a script the way Redis runs EVAL: KEYS and ARGV as tables of strings,
// redis.call() into `call`, and the result converted as Redis converts it
// (numbers to integers, tables to arrays). Throws if the script fails.
function evalLua(script, keys, argv, call) {
  const L = lauxlib.luaL_newstate();
  lauxlib.luaL_requiref(L, to_luastring("_G"), luaopen_base, 1);
  lua.lua_pop(L, 1);
  for (const [name, values] of [["KEYS", keys], ["ARGV", argv]]) {
    lua.lua_createtable(L, values.length, 0);
    values.forEach((value, i) => {
      lua.lua_pushstring(L, to_luastring(String(value)));
      lua.lua_rawseti(L, -2, i + 1);
    });
    lua.lua_setglobal(L, to_luastring(name));
  }
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsfunction(L, (L) => {
    const args = [];
    for (let i = 1; i <= lua.lua_gettop(L); i++) args.push(lua.lua_tojsstring(L, i));
    let result;
    try {
      result = call(args);
    } catch (err) {
      return lauxlib.luaL_error(L, to_luastring(err.message));
    }
    if (typeof result === "number") lua.lua_pushinteger(L, result);
    else if (typeof result === "string") lua.lua_pushstring(L, to_luastring(result));
    else lua.lua_pushboolean(L, false);
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("call"));
  lua.lua_setglobal(L, to_luastring("redis"));
  if (lauxlib.luaL_dostring(L, to_luastring(script)) !== lua.LUA_OK) {
    throw new Error(`ERR script failed: ${lua.lua_tojsstring(L, -1)}`);
  }
  const convert = (index) => {
    if (lua.lua_isinteger(L, index) || lua.lua_type(L, index) === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, index));
    if (lua.lua_type(L, index) === lua.LUA_TSTRING) return lua.lua_tojsstring(L, index);
    if (lua.lua_istable(L, index)) {
      const out = [];
      for (let i = 1; lua.lua_rawgeti(L, index, i) !== lua.LUA_TNIL; i++) {
        out.push(convert(lua.lua_gettop(L)));
        lua.lua_pop(L, 1);
      }
      lua.lua_pop(L, 1);
      return out;
    }
    return null;
  };
  return convert(lua.lua_gettop(L));
}

const REDIS_URL = "https://redis.test";
const REDIS_TOKEN = "test-token";
const ACCOUNT_ID = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const DOMAIN = "zerodrop-sandbox.online";
const CODE = "482913";
const SUBJECT = "Confirm your email";

// Which of the worker's scripts an EVAL runs.
const scriptName = (script) => (script.includes("LPUSH") ? "store" : script.includes("SCARD") ? "count" : "other");
const isStore = (command) => command[0] === "EVAL" && scriptName(command[1]) === "store";

function fakeRedis() {
  const strings = new Map();
  const lists = new Map();
  const sets = new Map();
  const ttls = new Map();
  const requests = [];
  const scriptsRun = [];
  let pipelineFailure = null;
  let failWhen = null;
  let evalFailure = null;

  function run([command, key, ...args]) {
    switch (command.toUpperCase()) {
      case "GET":
        return strings.has(key) ? strings.get(key) : null;
      case "EVAL": {
        // ["EVAL", script, numkeys, ...keys, ...args]
        const name = scriptName(key);
        scriptsRun.push(name);
        if (evalFailure === "string-reply" && name === "count") return ["-1", "5"];
        const numKeys = Number(args[0]);
        return evalLua(key, args.slice(1, 1 + numKeys), args.slice(1 + numKeys), run);
      }
      case "SCARD":
        return sets.get(key)?.size ?? 0;
      case "SISMEMBER":
        return sets.get(key)?.has(args[0]) ? 1 : 0;
      case "SADD": {
        const set = sets.get(key) ?? new Set();
        sets.set(key, set);
        const added = set.has(args[0]) ? 0 : 1;
        set.add(args[0]);
        return added;
      }
      case "LPUSH": {
        const list = lists.get(key) ?? [];
        lists.set(key, list);
        list.unshift(args[0]);
        return list.length;
      }
      case "LTRIM": {
        // Only the form the store script uses: LTRIM key 0 <last index>.
        const list = lists.get(key) ?? [];
        list.splice(Number(args[1]) + 1);
        return "OK";
      }
      case "TTL":
        if (ttls.has(key)) return ttls.get(key);
        return lists.has(key) || strings.has(key) || sets.has(key) ? -1 : -2;
      case "EXPIRE":
        ttls.set(key, Number(args[0]));
        return 1;
      default:
        throw new Error(`ERR fake Redis: unexpected command ${command}`);
    }
  }

  // One reply per command, as Upstash sends them.
  function reply(command) {
    try {
      return { result: run(command) };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function handle(url, init) {
    const path = new URL(url).pathname;
    const commands = JSON.parse(init.body);
    requests.push({ path, commands });
    if (init.headers.Authorization !== `Bearer ${REDIS_TOKEN}`) {
      return Response.json({ error: "WRONGPASS" }, { status: 401 });
    }
    if (path !== "/pipeline") throw new Error(`fake Redis: unexpected path ${path}`);
    if (pipelineFailure && failWhen(commands)) {
      if (pipelineFailure === "network") throw new TypeError("network connection lost");
      if (pipelineFailure === "error-reply") {
        return Response.json(commands.map(() => ({ error: "ERR max requests limit exceeded" })));
      }
      if (pipelineFailure === "http-500") return new Response("<html>bad gateway</html>", { status: 502 });
    }
    return Response.json(commands.map(reply));
  }

  return {
    strings,
    lists,
    sets,
    ttls,
    requests,
    handle,
    // Makes requests fail: by default every lookup and count, never the store
    // itself (the case the worker fails open for); `when` picks requests by
    // their commands instead.
    failPipeline(kind, when = (commands) => !commands.some(isStore)) {
      pipelineFailure = kind;
      failWhen = when;
    },
    failEval(kind) {
      evalFailure = kind;
    },
    // How many times a script ran: "store" (STORE_SCRIPT, so how many emails
    // were stored) or "count" (COUNT_SCRIPT).
    scriptRuns(name) {
      return scriptsRun.filter((n) => n === name).length;
    },
    // The emails stored for an inbox, newest first, as the read API sees them.
    inbox(name) {
      return (lists.get(`inbox:${name}`) ?? []).map((v) => JSON.parse(JSON.parse(v)[0]));
    },
    // The stored items themselves, before any parsing or decryption.
    items(name) {
      return (lists.get(`inbox:${name}`) ?? []).map((v) => JSON.parse(v)[0]);
    },
    commandsSent() {
      return requests.flatMap((r) => r.commands.map((c) => c[0]));
    },
  };
}

function message({ to, from = "noreply@app.example.com", headerFrom = `Example App <${from}>` }) {
  const raw = [
    `From: ${headerFrom}`,
    `To: ${to}`,
    `Subject: ${SUBJECT}`,
    `Message-ID: <msg-1@app.example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="b1"`,
    ``,
    `--b1`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Your verification code is ${CODE}.`,
    `--b1--`,
    ``,
  ].join("\r\n");
  const msg = {
    from,
    to,
    headers: new Headers({ from: headerFrom, to, subject: SUBJECT, "message-id": "<msg-1@app.example.com>" }),
    raw: new Response(raw).body,
    rawSize: raw.length,
    rejected: null,
    setReject(reason) {
      msg.rejected = reason;
    },
  };
  return msg;
}

let redis;
let logs;

beforeEach(() => {
  redis = fakeRedis();
  logs = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => redis.handle(url, init));
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseEnv = { UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: REDIS_TOKEN };
const today = () => new Date().toISOString().slice(0, 10);
const allowKey = (identity) => `allow:${identity}:${today()}`;
let counter = 0;
const freshName = (prefix = "swift") => `${prefix}-t${String(++counter).padStart(6, "0")}`;

async function deliver(name, { env = {}, ...opts } = {}) {
  const msg = message({ to: `${name}@${DOMAIN}`, ...opts });
  await worker.email(msg, { ...baseEnv, ...env }, { waitUntil() {} });
  return msg;
}

// Sends to n fresh inboxes from one sender and returns their names.
async function fillAllowance(n, opts = {}) {
  const names = [];
  for (let i = 0; i < n; i++) {
    const name = freshName();
    await deliver(name, opts);
    names.push(name);
  }
  return names;
}

describe("keyless allowance, enforced by default", () => {
  it("stores and counts the first 5 different inboxes from one sender", async () => {
    const names = await fillAllowance(5);
    for (const name of names) {
      const [email] = redis.inbox(name);
      expect(email.subject).toBe(SUBJECT);
      expect(email.otp).toBe(CODE);
      expect(email.held).toBeUndefined();
    }
    expect(redis.sets.get(allowKey("example.com")).size).toBe(5);
    expect(redis.ttls.get(allowKey("example.com"))).toBe(172800);
  });

  it("holds mail to a 6th inbox: a notice is stored instead and the email is not", async () => {
    await fillAllowance(5);
    const sixth = freshName();
    const msg = await deliver(sixth);

    expect(msg.rejected).toBeNull();
    const stored = redis.inbox(sixth);
    expect(stored).toHaveLength(1);
    const [notice] = stored;
    expect(notice.held).toBe(true);
    expect(notice.from).toBe("notice@zerodrop.dev");
    expect(notice.to).toBe(`${sixth}@${DOMAIN}`);
    expect(notice.otp).toBeNull();
    expect(notice.magicLink).toBeNull();
    expect(notice.raw).toContain("ZeroDrop held an email from example.com to this inbox");
    expect(notice.raw).toContain("https://zerodrop.dev/keys");
    expect(notice.raw).toContain("ZERODROP_API_KEY");
    // The clients raise an error with `reason`: the same text, on one line.
    expect(notice.reason).toMatch(/^ZeroDrop held an email from example\.com to this inbox\. The email was not stored\. Without an API key, one sender can reach 5 different inboxes a day, .* https:\/\/zerodrop\.dev\/keys .*isn't limited\.$/);
    expect(notice.reason).not.toMatch(/[\r\n]/);
    expect(notice.raw.replace(/^[\s\S]*?\r\n\r\n/, "").trim().split(/\s+/).join(" ")).toBe(notice.reason);
    // Nothing from the held message reaches the notice.
    expect(JSON.stringify(notice)).not.toContain(CODE);
    expect(JSON.stringify(notice)).not.toContain(SUBJECT);
    expect(JSON.stringify(notice)).not.toContain("noreply@app.example.com");
    // The held inbox doesn't join the day's set.
    expect(redis.sets.get(allowKey("example.com")).size).toBe(5);
    expect(logs.some((l) => l.includes(`[ZeroDrop] Held sender=example.com inbox=${sixth} distinct_today=5`))).toBe(true);
  });

  it("keeps delivering to inboxes the sender already reached today", async () => {
    const names = await fillAllowance(5);
    await deliver(names[2]);
    expect(redis.inbox(names[2])).toHaveLength(2);
    expect(redis.inbox(names[2]).every((e) => e.subject === SUBJECT)).toBe(true);
  });

  it("counts subdomains of one sender together", async () => {
    await fillAllowance(3, { from: "noreply@mail.example.com" });
    await fillAllowance(2, { from: "hello@example.com" });
    const sixth = freshName();
    await deliver(sixth, { from: "noreply@auth.example.com" });
    expect(redis.inbox(sixth)[0].held).toBe(true);
  });

  it("counts consumer mailboxes per address and keeps the address out of the notice", async () => {
    await fillAllowance(5, { from: "alice@gmail.com" });
    const bobs = await fillAllowance(5, { from: "bob@gmail.com" });
    expect(redis.inbox(bobs[4])[0].held).toBeUndefined();

    const sixth = freshName();
    await deliver(sixth, { from: "alice@gmail.com" });
    const [notice] = redis.inbox(sixth);
    expect(notice.held).toBe(true);
    expect(notice.raw).toContain("from an address at gmail.com to this inbox");
    expect(JSON.stringify(notice)).not.toContain("alice");
  });

  it("names the sender in the notice only when its domain is a plain host name", async () => {
    const crafted = { from: "bounce@mailer.example.net", headerFrom: "<a@x.https://evil.example/keys>" };
    await fillAllowance(5, crafted);
    const sixth = freshName();
    await deliver(sixth, crafted);
    const [notice] = redis.inbox(sixth);
    expect(notice.held).toBe(true);
    expect(notice.reason).toMatch(/^ZeroDrop held an email from this sender to this inbox\./);
    expect(JSON.stringify(notice)).not.toContain("evil");
  });

  it("never logs the code or the subject line", async () => {
    await fillAllowance(6);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(CODE);
      expect(line).not.toContain(SUBJECT);
    }
  });

  it("doesn't count mail to any other receiving domain: a Workspace's, or a self-hosted one", async () => {
    await fillAllowance(5);
    redis.strings.set("domain:qa.customer.example", "k7x2");
    redis.strings.set("ns:k7x2", ACCOUNT_ID);
    for (let i = 0; i < 3; i++) {
      const name = freshName();
      const msg = message({ to: `${name}@qa.customer.example` });
      await worker.email(msg, baseEnv, { waitUntil() {} });
      expect(msg.rejected).toBeNull();
      expect(redis.inbox(`k7x2-${name}`)[0].subject).toBe(SUBJECT);
      const own = freshName();
      const selfHosted = message({ to: `${own}@self-hosted.example` });
      await worker.email(selfHosted, { ...baseEnv, DOMAIN_MODE: "open" }, { waitUntil() {} });
      expect(selfHosted.rejected).toBeNull();
      expect(redis.inbox(own)[0].subject).toBe(SUBJECT);
    }
    expect(redis.sets.get(allowKey("example.com")).size).toBe(5);
  });

  it("matches the sandbox domain case-insensitively", async () => {
    await fillAllowance(5);
    const name = freshName();
    const msg = message({ to: `${name}@ZeroDrop-Sandbox.Online` });
    await worker.email(msg, baseEnv, { waitUntil() {} });
    expect(redis.inbox(name)[0].held).toBe(true);
  });

  it("lets only 5 of 12 new inboxes through when the mail arrives at once", async () => {
    const names = Array.from({ length: 12 }, () => freshName());
    await Promise.all(names.map((name) => deliver(name)));
    const admitted = names.filter((name) => redis.inbox(name)[0].subject === SUBJECT);
    const held = names.filter((name) => redis.inbox(name)[0].held === true);
    expect(admitted).toHaveLength(5);
    expect(held).toHaveLength(7);
    expect(redis.sets.get(allowKey("example.com")).size).toBe(5);
  });

  it("holds every copy sent at once to a new inbox past the allowance", async () => {
    await fillAllowance(5);
    const sixth = freshName();
    await Promise.all([deliver(sixth), deliver(sixth), deliver(sixth)]);
    const stored = redis.inbox(sixth);
    expect(stored).toHaveLength(3);
    expect(stored.every((e) => e.held === true)).toBe(true);
  });
});

describe("ALLOWANCE_MODE", () => {
  it("shadow stores mail past the allowance and logs what it would hold", async () => {
    const env = { ALLOWANCE_MODE: "shadow" };
    await fillAllowance(5, { env });
    const sixth = freshName();
    await deliver(sixth, { env });
    expect(redis.inbox(sixth)[0].subject).toBe(SUBJECT);
    expect(logs.some((l) => l.includes(`Allowance would hold (shadow) sender=example.com inbox=${sixth}`))).toBe(true);
    expect(logs.some((l) => l.includes("[ZeroDrop] Held"))).toBe(false);
  });

  it("reads the value case-insensitively and ignores surrounding whitespace", async () => {
    const env = { ALLOWANCE_MODE: "  Shadow\n" };
    await fillAllowance(5, { env });
    const sixth = freshName();
    await deliver(sixth, { env });
    expect(redis.inbox(sixth)[0].held).toBeUndefined();
    expect(logs.some((l) => l.includes(`Allowance would hold (shadow) sender=example.com inbox=${sixth}`))).toBe(true);
    expect(redis.sets.get(allowKey("example.com")).size).toBe(6);
  });

  it("off doesn't count at all", async () => {
    const env = { ALLOWANCE_MODE: "off" };
    const names = await fillAllowance(7, { env });
    expect(redis.inbox(names[6])[0].subject).toBe(SUBJECT);
    expect(redis.sets.size).toBe(0);
    expect(redis.scriptRuns("count")).toBe(0);
  });

  it("enforces for any other value", async () => {
    const env = { ALLOWANCE_MODE: "enforced" };
    await fillAllowance(5, { env });
    const sixth = freshName();
    await deliver(sixth, { env });
    expect(redis.inbox(sixth)[0].held).toBe(true);
  });
});

describe("account prefixes", () => {
  it("doesn't count mail to an active account's prefix", async () => {
    redis.strings.set("ns:k7x2", ACCOUNT_ID);
    await fillAllowance(5);
    const name = freshName("k7x2-swift");
    await deliver(name);
    expect(redis.inbox(name)[0].subject).toBe(SUBJECT);
    expect(redis.sets.get(allowKey("example.com")).has(name)).toBe(false);
  });

  it.each(["suspended", "retired"])("rejects mail to a %s prefix without storing or counting it", async (state) => {
    redis.strings.set("ns:k7x2", state);
    const name = freshName("k7x2-swift");
    const msg = await deliver(name);
    expect(msg.rejected).toBe("This inbox is closed");
    expect(redis.inbox(name)).toHaveLength(0);
    expect(redis.scriptRuns("store")).toBe(0);
    expect(redis.scriptRuns("count")).toBe(0);
    expect(logs.some((l) => l.includes("Rejected mail to a closed prefix ns=k7x2 sender=example.com"))).toBe(true);
  });

  it.each([
    ["an upper-case account id", ACCOUNT_ID.toUpperCase()],
    ["36 characters that aren't an account id", "x".repeat(36)],
    ["any other word", "deleted"],
  ])("treats %s as closed, as the read API does", async (_, value) => {
    redis.strings.set("ns:k7x2", value);
    const msg = await deliver(freshName("k7x2-swift"));
    expect(msg.rejected).toBe("This inbox is closed");
  });

  it("rejects mail to a closed prefix from an allowlisted sender and with the allowance off", async () => {
    redis.strings.set("ns:k7x2", "suspended");
    const allowlisted = await deliver(freshName("k7x2-swift"), { env: { CAP_ALLOWLIST: "example.com" } });
    expect(allowlisted.rejected).toBe("This inbox is closed");
    const off = await deliver(freshName("k7x2-swift"), { env: { ALLOWANCE_MODE: "off" } });
    expect(off.rejected).toBe("This inbox is closed");
  });

  it("counts an unregistered prefix like any keyless inbox", async () => {
    await fillAllowance(5);
    const name = freshName("k7x2-swift");
    await deliver(name);
    expect(redis.inbox(name)[0].held).toBe(true);
  });

  it("keeps delivering to an unregistered prefix's inbox the sender already reached", async () => {
    const name = freshName("k7x2-swift");
    await deliver(name);
    await fillAllowance(4);
    await deliver(name);
    expect(redis.inbox(name)).toHaveLength(2);
    expect(redis.inbox(name).every((e) => e.subject === SUBJECT)).toBe(true);
  });

  it("looks up only names that start with a namespace", async () => {
    await deliver(freshName("dark")); // adjective, no digit
    await deliver(freshName("abcd")); // no digit
    await deliver(freshName("1234")); // no letter
    expect(redis.commandsSent()).not.toContain("GET");
    await deliver(freshName("ab12"));
    expect(redis.commandsSent()).toContain("GET");
  });
});

describe("grace allowlist", () => {
  it("exempts a listed parent domain", async () => {
    const env = { CAP_ALLOWLIST: "other.org, example.com" };
    const names = await fillAllowance(7, { env, from: "noreply@mail.example.com" });
    expect(redis.inbox(names[6])[0].subject).toBe(SUBJECT);
    expect(redis.sets.size).toBe(0);
  });

  it("stops exempting after ALLOWLIST_UNTIL", async () => {
    const env = { CAP_ALLOWLIST: "example.com", ALLOWLIST_UNTIL: "2000-01-01" };
    await fillAllowance(5, { env });
    const sixth = freshName();
    await deliver(sixth, { env });
    expect(redis.inbox(sixth)[0].held).toBe(true);
  });

  it("keeps exempting until then", async () => {
    const env = { CAP_ALLOWLIST: "example.com", ALLOWLIST_UNTIL: "2999-12-31" };
    const names = await fillAllowance(6, { env });
    expect(redis.inbox(names[5])[0].held).toBeUndefined();
  });
});

describe("fails open", () => {
  it.each(["network", "error-reply", "http-500"])("stores the email when the check fails (%s)", async (kind) => {
    await fillAllowance(5);
    redis.strings.set("ns:k7x2", "suspended");
    redis.failPipeline(kind);
    const keyless = freshName();
    const closed = freshName("k7x2-swift");
    const a = await deliver(keyless);
    const b = await deliver(closed);
    expect(a.rejected).toBeNull();
    expect(b.rejected).toBeNull();
    expect(redis.inbox(keyless)[0].subject).toBe(SUBJECT);
    expect(redis.inbox(closed)[0].subject).toBe(SUBJECT);
    expect(logs.filter((l) => l.includes("Allowance check error — allowing email through"))).toHaveLength(2);
  });

  it("stores the email and logs it when the count script's reply makes no sense", async () => {
    await fillAllowance(5);
    redis.failEval("string-reply");
    const sixth = freshName();
    await deliver(sixth);
    expect(redis.inbox(sixth)[0].subject).toBe(SUBJECT);
    expect(logs.some((l) => l.includes("Allowance check error — allowing email through: unexpected reply from the count script"))).toBe(true);
  });
});

describe("Workspaces", () => {
  const WS = "qa.example"; // a Workspace's own domain
  const register = (ns = "k7x2", state = ACCOUNT_ID) => {
    redis.strings.set(`domain:${WS}`, ns);
    if (state) redis.strings.set(`ns:${ns}`, state);
  };
  async function deliverTo(address, { env = {}, ...opts } = {}) {
    const msg = message({ to: address, ...opts });
    await worker.email(msg, { ...baseEnv, ...env }, { waitUntil() {} });
    return msg;
  }

  it("files a Workspace domain's mail under its owner's namespace", async () => {
    register();
    const name = freshName();
    const msg = await deliverTo(`${name}@${WS}`);
    expect(msg.rejected).toBeNull();
    const [email] = redis.inbox(`k7x2-${name}`);
    expect(email.subject).toBe(SUBJECT);
    expect(email.to).toBe(`${name}@${WS}`);
    expect(redis.inbox(name)).toHaveLength(0);
  });

  it("keeps a name that already has the owner's prefix, and matches the domain case-insensitively", async () => {
    register();
    const name = freshName("k7x2-swift");
    await deliverTo(`${name}@QA.Example.`);
    expect(redis.inbox(name)[0].subject).toBe(SUBJECT);
  });

  it("files another account's prefix under the owner's, never the other account's", async () => {
    register();
    redis.strings.set("ns:ab12", "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a");
    const name = freshName("ab12-swift");
    await deliverTo(`${name}@${WS}`);
    expect(redis.inbox(`k7x2-${name}`)[0].subject).toBe(SUBJECT);
    expect(redis.inbox(name)).toHaveLength(0);
  });

  it("rejects a name that would pass 64 characters with the prefix", async () => {
    register();
    const name = "a".repeat(60);
    const msg = await deliverTo(`${name}@${WS}`);
    expect(msg.rejected).toBe("Invalid recipient");
    expect(redis.scriptRuns("store")).toBe(0);
  });

  it("doesn't count it against the allowance", async () => {
    register();
    for (let i = 0; i < 7; i++) await deliverTo(`${freshName()}@${WS}`);
    const name = freshName();
    const msg = await deliverTo(`${name}@${WS}`);
    expect(msg.rejected).toBeNull();
    expect(redis.inbox(`k7x2-${name}`)[0].subject).toBe(SUBJECT);
    expect(redis.scriptRuns("count")).toBe(0);
  });

  it.each(["noreply@reddit.com", "noreply@tm.openai.com"])(
    "rejects a blocklisted sender (%s), as the shared domain does",
    async (from) => {
      register();
      const name = freshName();
      const msg = await deliverTo(`${name}@${WS}`, { from });
      expect(msg.rejected).toBe("Mail from this sender is not accepted");
      expect(redis.scriptRuns("store")).toBe(0);
      expect(redis.inbox(`k7x2-${name}`)).toHaveLength(0);
      expect((await deliver(freshName(), { from })).rejected).toBe("Mail from this sender is not accepted");
    }
  );

  it.each([
    ["suspended", "suspended"],
    ["deleted", "retired"],
    ["missing", null],
  ])("rejects mail for a Workspace whose account is %s", async (_, state) => {
    register("k7x2", state);
    const msg = await deliverTo(`${freshName()}@${WS}`);
    expect(msg.rejected).toBe("This inbox is closed");
    expect(redis.scriptRuns("store")).toBe(0);
  });

  it.each(["removed:k7x2", "removed", "not-a-namespace"])("rejects mail to a domain whose record is %s", async (value) => {
    redis.strings.set(`domain:${WS}`, value);
    const name = freshName();
    const msg = await deliverTo(`${name}@${WS}`);
    expect(msg.rejected).toBe("This inbox is closed");
    expect(redis.scriptRuns("store")).toBe(0);
    expect(redis.inbox(name)).toHaveLength(0);
  });

  it.each(["network", "error-reply", "http-500"])(
    "throws and stores nothing when it can't look the domain up (%s)",
    async (kind) => {
      register();
      redis.failPipeline(kind);
      const msg = message({ to: `${freshName()}@${WS}` });
      await expect(worker.email(msg, baseEnv, { waitUntil() {} })).rejects.toThrow();
      expect(redis.scriptRuns("store")).toBe(0);
      expect(logs.some((l) => l.includes("Domain lookup failed, nothing stored"))).toBe(true);
    }
  );

  it.each(["network", "error-reply", "http-500"])(
    "throws and stores nothing when it can't check the owner's account (%s)",
    async (kind) => {
      register();
      redis.failPipeline(kind, (commands) => commands.some((c) => String(c[1]).startsWith("ns:")));
      const name = freshName();
      const msg = message({ to: `${name}@${WS}` });
      await expect(worker.email(msg, baseEnv, { waitUntil() {} })).rejects.toThrow();
      expect(redis.scriptRuns("store")).toBe(0);
      expect(redis.inbox(`k7x2-${name}`)).toHaveLength(0);
      expect(redis.inbox(name)).toHaveLength(0);
      expect(logs.some((l) => l.includes("Account check failed for a Workspace domain ns=k7x2, nothing stored"))).toBe(true);
    }
  );

  it("files the same name on each of an account's domains, and its prefix on the shared one, in one inbox", async () => {
    register();
    redis.strings.set("domain:b.example", "k7x2");
    const name = freshName();
    await deliverTo(`${name}@${WS}`);
    await deliverTo(`${name}@b.example`);
    await deliver(`k7x2-${name}`);
    expect(redis.inbox(`k7x2-${name}`).map((e) => e.to)).toEqual([
      `k7x2-${name}@${DOMAIN}`,
      `${name}@b.example`,
      `${name}@${WS}`,
    ]);
  });

  it("stores mail to an unregistered domain as before with DOMAIN_MODE=open (self-hosting)", async () => {
    const name = freshName();
    await deliverTo(`${name}@self-hosted.example`, { env: { DOMAIN_MODE: "open" } });
    expect(redis.inbox(name)[0].subject).toBe(SUBJECT);
    expect(redis.ttls.get(`inbox:${name}`)).toBe(1800);
  });

  it("encrypts a Workspace's mail bound to the inbox it's filed under", async () => {
    register();
    const name = freshName();
    await deliverTo(`${name}@${WS}`, { env: { INBOX_ENCRYPTION_KEY: KEY } });
    const [item] = redis.items(`k7x2-${name}`);
    expect((await openItem(item, `inbox:k7x2-${name}`)).otp).toBe(CODE);
  });
});

describe("retention", () => {
  const ttlOf = (name) => redis.ttls.get(`inbox:${name}`);

  it("keeps an account's inboxes for its retention, on its domain and on the shared one", async () => {
    redis.strings.set("domain:qa.example", "k7x2");
    redis.strings.set("ns:k7x2", ACCOUNT_ID);
    redis.strings.set("ttl:k7x2", "86400");
    const own = freshName();
    await worker.email(message({ to: `${own}@qa.example` }), baseEnv, { waitUntil() {} });
    const shared = freshName("k7x2-swift");
    await deliver(shared);
    expect(ttlOf(`k7x2-${own}`)).toBe(86400);
    expect(ttlOf(shared)).toBe(86400);
  });

  it.each([
    ["more than 7 days", "9999999", 604800],
    ["under a minute", "5", 60],
    ["with spaces around it", " 600 ", 600],
    ["not a whole number", "1.5", 1800],
    ["in exponent form", "1e3", 1800],
    ["zero", "0", 1800],
    ["negative", "-600", 1800],
    ["not a number", "abc", 1800],
    ["unset", null, 1800],
  ])("keeps a retention of %s within bounds", async (_, value, expected) => {
    redis.strings.set("ns:k7x2", ACCOUNT_ID);
    if (value !== null) redis.strings.set("ttl:k7x2", value);
    const name = freshName("k7x2-swift");
    await deliver(name);
    expect(ttlOf(name)).toBe(expected);
  });

  it("keeps 30 minutes for keyless inboxes and for an unregistered prefix", async () => {
    redis.strings.set("ttl:k7x2", "86400"); // no ns:k7x2: not an account
    const keyless = freshName();
    const unregistered = freshName("k7x2-swift");
    await deliver(keyless);
    await deliver(unregistered);
    expect(ttlOf(keyless)).toBe(1800);
    expect(ttlOf(unregistered)).toBe(1800);
  });

  it("stores with 30 minutes when the account check fails, never cutting short an inbox kept longer", async () => {
    redis.strings.set("ns:k7x2", ACCOUNT_ID);
    redis.strings.set("ttl:k7x2", "86400");
    const kept = freshName("k7x2-swift");
    await deliver(kept);
    expect(ttlOf(kept)).toBe(86400);

    redis.failPipeline("network");
    await deliver(kept);
    const fresh = freshName("k7x2-swift");
    await deliver(fresh);
    expect(redis.inbox(kept)).toHaveLength(2);
    expect(ttlOf(kept)).toBe(86400);
    expect(ttlOf(fresh)).toBe(1800);
  });

  it("applies a lowered retention to new inboxes; one already kept longer runs out its time", async () => {
    redis.strings.set("ns:k7x2", ACCOUNT_ID);
    redis.strings.set("ttl:k7x2", "604800");
    const kept = freshName("k7x2-swift");
    await deliver(kept);
    redis.strings.delete("ttl:k7x2");
    await deliver(kept);
    const fresh = freshName("k7x2-swift");
    await deliver(fresh);
    expect(ttlOf(kept)).toBe(604800);
    expect(ttlOf(fresh)).toBe(1800);
  });

  it("restarts a 30-minute inbox's timer with every email", async () => {
    const name = freshName();
    await deliver(name);
    redis.ttls.set(`inbox:${name}`, 12); // 12 seconds left
    await deliver(name);
    expect(ttlOf(name)).toBe(1800);
  });
});

describe("storage", () => {
  it("keeps each inbox's newest 50 emails", async () => {
    const name = freshName();
    for (let i = 0; i < 53; i++) await deliver(name);
    expect(redis.lists.get(`inbox:${name}`)).toHaveLength(50);
  });

  it("stores each email and its expiry in one script", async () => {
    const name = freshName();
    await deliver(name);
    const stores = redis.requests.filter((r) => r.commands.some(isStore));
    expect(stores).toHaveLength(1);
    expect(stores[0].commands).toHaveLength(1);
    const [, , numKeys, key, , ttl, lastIndex] = stores[0].commands[0];
    expect([numKeys, key, ttl, lastIndex]).toEqual(["1", `inbox:${name}`, "1800", "49"]);
    expect(redis.ttls.get(`inbox:${name}`)).toBe(1800);
  });
});

describe("recipient domain", () => {
  const register = (domain, ns = "k7x2") => {
    redis.strings.set(`domain:${domain}`, ns);
    redis.strings.set(`ns:${ns}`, ACCOUNT_ID);
  };
  async function deliverTo(address, env = {}) {
    const msg = message({ to: address });
    await worker.email(msg, { ...baseEnv, ...env }, { waitUntil() {} });
    return msg;
  }

  it.each([
    ["upper case and trailing dots", (n) => `${n}@QA.EXAMPLE..`],
    ["an ideographic full stop", (n) => `${n}@qa。example`],
    ["full-width letters", (n) => `${n}@ｑａ.example`],
  ])("finds a Workspace domain written with %s", async (_, address) => {
    register("qa.example");
    const name = freshName();
    const msg = await deliverTo(address(name));
    expect(msg.rejected).toBeNull();
    expect(redis.inbox(`k7x2-${name}`)).toHaveLength(1);
    expect(redis.inbox(name)).toHaveLength(0);
  });

  it("finds an internationalized Workspace domain by its xn-- form", async () => {
    register("xn--bcher-kva.example");
    const name = freshName();
    await deliverTo(`${name}@bücher.example`);
    await deliverTo(`${name}@BÜCHER.example`);
    expect(redis.inbox(`k7x2-${name}`)).toHaveLength(2);
    expect(redis.inbox(name)).toHaveLength(0);
  });

  it.each([
    ["an underscore", "qa_example.com"],
    ["a leading hyphen", "-qa.example"],
    ["a path", "qa.example/inbox"],
    ["a port", "qa.example:25"],
    ["an address literal", "[127.0.0.1]"],
    ["a single label", "localhost"],
    ["an empty label", "qa..example"],
    ["nothing", ""],
  ])("rejects a recipient domain with %s before Redis", async (_, domain) => {
    const msg = await deliverTo(`${freshName()}@${domain}`);
    expect(msg.rejected).toBe("Invalid recipient");
    expect(redis.requests).toHaveLength(0);
  });

  describe("DOMAIN_MODE", () => {
    it.each([undefined, "", "strict", " STRICT\n", "anything else"])(
      "rejects mail to an unregistered domain when it is %j",
      async (mode) => {
        const name = freshName();
        const msg = await deliverTo(`${name}@other.example`, mode === undefined ? {} : { DOMAIN_MODE: mode });
        expect(msg.rejected).toBe("Unknown recipient domain");
        expect(redis.scriptRuns("store")).toBe(0);
        expect(logs.some((l) => l.includes("Rejected mail to unregistered domain other.example"))).toBe(true);
      }
    );

    it("rejects a subdomain of a Workspace's domain by default", async () => {
      register("qa.example");
      const msg = await deliverTo(`${freshName()}@mail.qa.example`);
      expect(msg.rejected).toBe("Unknown recipient domain");
      expect(redis.scriptRuns("store")).toBe(0);
    });

    it("rejects mail to a domain whose record has been forgotten", async () => {
      register("qa.example");
      redis.strings.delete("domain:qa.example");
      const msg = await deliverTo(`${freshName()}@qa.example`);
      expect(msg.rejected).toBe("Unknown recipient domain");
      expect(redis.scriptRuns("store")).toBe(0);
    });

    it("still receives mail for the shared domain and Workspace domains by default", async () => {
      register("qa.example");
      const shared = freshName();
      const own = freshName();
      expect((await deliverTo(`${shared}@${DOMAIN}`)).rejected).toBeNull();
      expect((await deliverTo(`${own}@qa.example`)).rejected).toBeNull();
      expect(redis.inbox(shared)).toHaveLength(1);
      expect(redis.inbox(`k7x2-${own}`)).toHaveLength(1);
    });

    it.each(["open", " Open "])("stores mail to an unregistered domain as before when it is %j", async (mode) => {
      const name = freshName();
      const msg = await deliverTo(`${name}@other.example`, { DOMAIN_MODE: mode });
      expect(msg.rejected).toBeNull();
      expect(redis.inbox(name)).toHaveLength(1);
    });
  });
});

// Opens a stored item the way the read API does, written independently of
// src/encryption.js so the two can't share a mistake: the format is
// "zd1:<key id>:<iv>:<ciphertext>", base64url, with "zd1:<key id>:" and the
// Redis key as the additional authenticated data.
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // bytes 0..31
const fromB64 = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function openItem(item, redisKey, keyB64 = KEY) {
  const [version, keyId, iv, ciphertext] = item.split(":");
  if (version !== "zd1") throw new Error(`not a sealed item: ${item.slice(0, 20)}`);
  const key = await crypto.subtle.importKey("raw", fromB64(keyB64), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(iv), additionalData: new TextEncoder().encode(`${version}:${keyId}:${redisKey}`) },
    key,
    fromB64(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

describe("encryption at rest", () => {
  const env = { INBOX_ENCRYPTION_KEY: KEY };

  it("stores each email encrypted, with nothing readable left in it", async () => {
    const name = freshName();
    await deliver(name, { env });
    const [item] = redis.items(name);
    expect(item).toMatch(/^zd1:[0-9a-f]{8}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    for (const plain of [CODE, SUBJECT, "noreply@app.example.com", name]) expect(item).not.toContain(plain);

    const email = await openItem(item, `inbox:${name}`);
    expect(email.subject).toBe(SUBJECT);
    expect(email.otp).toBe(CODE);
    expect(email.to).toBe(`${name}@${DOMAIN}`);
  });

  it("still stores the email and its 30-minute expiry in one script", async () => {
    const name = freshName();
    await deliver(name, { env });
    expect(redis.scriptRuns("store")).toBe(1);
    expect(redis.ttls.get(`inbox:${name}`)).toBe(1800);
  });

  it("binds each email to its inbox: it won't decrypt as another inbox's", async () => {
    const name = freshName();
    await deliver(name, { env });
    const [item] = redis.items(name);
    await expect(openItem(item, `inbox:${freshName()}`)).rejects.toThrow();
  });

  it("binds each email to its header: relabelled with another key id, it won't decrypt", async () => {
    const name = freshName();
    await deliver(name, { env });
    const [item] = redis.items(name);
    const parts = item.split(":");
    const relabelled = [parts[0], parts[1] === "00000000" ? "ffffffff" : "00000000", parts[2], parts[3]].join(":");
    await expect(openItem(relabelled, `inbox:${name}`)).rejects.toThrow();
    expect((await openItem(item, `inbox:${name}`)).otp).toBe(CODE);
  });

  it("uses a new IV for every email", async () => {
    const name = freshName();
    await deliver(name, { env });
    await deliver(name, { env });
    const [second, first] = redis.items(name);
    expect(second.split(":")[2]).not.toBe(first.split(":")[2]);
    expect(second.split(":")[3]).not.toBe(first.split(":")[3]);
  });

  it("encrypts held notices too", async () => {
    await fillAllowance(5, { env });
    const sixth = freshName();
    await deliver(sixth, { env });
    const notice = await openItem(redis.items(sixth)[0], `inbox:${sixth}`);
    expect(notice.held).toBe(true);
    expect(notice.reason).toMatch(/^ZeroDrop held an email from example\.com/);
  });

  it("names the key by the first 8 hex characters of its SHA-256", async () => {
    const name = freshName();
    await deliver(name, { env });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64(KEY)));
    const keyId = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(redis.items(name)[0].split(":")[1]).toBe(keyId);
  });

  it("accepts the key in base64url form, with surrounding whitespace", async () => {
    const urlForm = ` ${KEY.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}\n`;
    const name = freshName();
    await deliver(name, { env: { INBOX_ENCRYPTION_KEY: urlForm } });
    expect((await openItem(redis.items(name)[0], `inbox:${name}`)).otp).toBe(CODE);
  });

  it.each([
    ["too short", "c2hvcnQ="],
    ["too long", btoa("x".repeat(33))],
    ["not base64", "not a key!"],
    ["empty", ""],
    ["only whitespace", "  \n"],
  ])("stores nothing with a key that is %s, rather than storing it unencrypted", async (_, badKey) => {
    const name = freshName();
    const msg = message({ to: `${name}@${DOMAIN}` });
    await expect(worker.email(msg, { ...baseEnv, INBOX_ENCRYPTION_KEY: badKey }, { waitUntil() {} })).rejects.toThrow(
      "INBOX_ENCRYPTION_KEY must be 32 bytes, base64-encoded"
    );
    expect(redis.scriptRuns("store")).toBe(0);
  });

  it("logs whether each email was encrypted, and never the key", async () => {
    await deliver(freshName(), { env });
    await deliver(freshName());
    expect(logs.filter((l) => l.endsWith("encrypted=yes"))).toHaveLength(1);
    expect(logs.filter((l) => l.endsWith("encrypted=no"))).toHaveLength(1);
    for (const line of logs) expect(line).not.toContain(KEY);
  });

  it("encodes and decodes base64url to a known vector", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    expect(toBase64url(bytes)).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect([...decodeBase64(KEY)]).toEqual([...bytes]);
    expect([...decodeBase64("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")]).toEqual([...bytes]);
    expect(decodeBase64("not base64!")).toBeNull();
    expect(decodeBase64("abcde")).toBeNull();
  });

  it("stores plain JSON without the key, as before", async () => {
    const name = freshName();
    await deliver(name);
    expect(JSON.parse(redis.items(name)[0]).otp).toBe(CODE);
  });

  it.each(["true", "TRUE ", "1", "yes", "on", "enabled"])(
    "with INBOX_ENCRYPTION_REQUIRED=%j and no key, stores nothing rather than plain JSON",
    async (value) => {
      const msg = message({ to: `${freshName()}@${DOMAIN}` });
      await expect(
        worker.email(msg, { ...baseEnv, INBOX_ENCRYPTION_REQUIRED: value }, { waitUntil() {} })
      ).rejects.toThrow("INBOX_ENCRYPTION_REQUIRED is set but INBOX_ENCRYPTION_KEY isn't");
      expect(redis.scriptRuns("store")).toBe(0);
    }
  );

  it("with INBOX_ENCRYPTION_REQUIRED and the key, encrypts as usual", async () => {
    const name = freshName();
    await deliver(name, { env: { ...env, INBOX_ENCRYPTION_REQUIRED: "true" } });
    expect((await openItem(redis.items(name)[0], `inbox:${name}`)).otp).toBe(CODE);
  });

  it.each(["", "0", "false", "No", " off "])("treats INBOX_ENCRYPTION_REQUIRED=%j as off", async (value) => {
    const name = freshName();
    await deliver(name, { env: { INBOX_ENCRYPTION_REQUIRED: value } });
    expect(JSON.parse(redis.items(name)[0]).otp).toBe(CODE);
  });
});

describe("rejected before Redis", () => {
  it.each(["noreply@sc.mail.deepseek.com", "noreply@tm.openai.com"])("rejects blocked senders (%s)", async (from) => {
    const msg = await deliver(freshName(), { from });
    expect(msg.rejected).toBe("Mail from this sender is not accepted");
    expect(redis.requests).toHaveLength(0);
  });

  it("rejects malformed recipients", async () => {
    const msg = await deliver("Not Valid!");
    expect(msg.rejected).toBe("Invalid recipient");
    expect(redis.requests).toHaveLength(0);
  });
});
