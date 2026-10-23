import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Only fengari's core and base library: its full library set needs Node APIs
// that the Workers runtime doesn't have.
import * as lua from "fengari/src/lua.js";
import * as lauxlib from "fengari/src/lauxlib.js";
import { luaopen_base } from "fengari/src/lbaselib.js";
import { to_luastring } from "fengari/src/fengaricore.js";
import worker from "../src";

// The email handler, run against an in-memory stand-in for Upstash's REST API
// (/pipeline and /multi-exec, with the commands the worker sends). EVAL runs
// the worker's actual Lua script, in fengari (Lua 5.3; Redis runs 5.1, which
// behaves the same for everything the count script uses).

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

function fakeRedis() {
  const strings = new Map();
  const lists = new Map();
  const sets = new Map();
  const ttls = new Map();
  const requests = [];
  let pipelineFailure = null;
  let evalFailure = null;

  function run([command, key, ...args]) {
    switch (command.toUpperCase()) {
      case "GET":
        return strings.has(key) ? strings.get(key) : null;
      case "EVAL": {
        // ["EVAL", script, numkeys, ...keys, ...args]
        if (evalFailure === "string-reply") return ["-1", "5"];
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
    if (path === "/pipeline" && pipelineFailure === "network") throw new TypeError("network connection lost");
    if (path === "/pipeline" && pipelineFailure === "error-reply") {
      return Response.json(commands.map(() => ({ error: "ERR max requests limit exceeded" })));
    }
    if (path === "/pipeline" && pipelineFailure === "http-500") {
      return new Response("<html>bad gateway</html>", { status: 502 });
    }
    if (path !== "/pipeline" && path !== "/multi-exec") throw new Error(`fake Redis: unexpected path ${path}`);
    return Response.json(commands.map(reply));
  }

  return {
    strings,
    sets,
    ttls,
    requests,
    handle,
    failPipeline(kind) {
      pipelineFailure = kind;
    },
    failEval(kind) {
      evalFailure = kind;
    },
    // The emails stored for an inbox, newest first, as the read API sees them.
    inbox(name) {
      return (lists.get(`inbox:${name}`) ?? []).map((v) => JSON.parse(JSON.parse(v)[0]));
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

  it("doesn't count mail to any other receiving domain, such as a Workspace's", async () => {
    await fillAllowance(5);
    for (let i = 0; i < 3; i++) {
      const name = freshName();
      const msg = message({ to: `${name}@qa.customer.example` });
      await worker.email(msg, baseEnv, { waitUntil() {} });
      expect(msg.rejected).toBeNull();
      expect(redis.inbox(name)[0].subject).toBe(SUBJECT);
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
    expect(redis.commandsSent()).not.toContain("EVAL");
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
    expect(redis.commandsSent()).not.toContain("LPUSH");
    expect(redis.commandsSent()).not.toContain("EVAL");
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

describe("rejected before Redis", () => {
  it("rejects blocked senders", async () => {
    const msg = await deliver(freshName(), { from: "noreply@sc.mail.deepseek.com" });
    expect(msg.rejected).toBe("Mail from this sender is not accepted");
    expect(redis.requests).toHaveLength(0);
  });

  it("rejects malformed recipients", async () => {
    const msg = await deliver("Not Valid!");
    expect(msg.rejected).toBe("Invalid recipient");
    expect(redis.requests).toHaveLength(0);
  });
});
