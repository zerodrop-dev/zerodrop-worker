import { describe, expect, it } from "vitest";
import { asciiDomain, authFromRaw, headerFields, headerFromAddress, parseAuthResults } from "../src/auth.js";
import cloudflarePass from "./fixtures/hostile/cloudflare-pass-with-forged-copy.eml?raw";
import forgedBelow from "./fixtures/hostile/forged-below-cloudflare-block.eml?raw";
import forgedResultAndScore from "./fixtures/hostile/forged-result-and-score.eml?raw";
import noCloudflareBlock from "./fixtures/hostile/no-cloudflare-block.eml?raw";
import dmarcNone from "./fixtures/hostile/dmarc-none.eml?raw";
import dmarcFail from "./fixtures/hostile/dmarc-fail.eml?raw";
import dmarcPassOtherDomain from "./fixtures/hostile/dmarc-pass-other-domain.eml?raw";
import twoResults from "./fixtures/hostile/two-results-in-block.eml?raw";
import commentLooksLikePass from "./fixtures/hostile/comment-looks-like-pass.eml?raw";
import displayNameInjection from "./fixtures/hostile/display-name-injection.eml?raw";
import lookalikeFrom from "./fixtures/hostile/lookalike-from-domain.eml?raw";

// The visible From, as message.headers.get("from") gives it.
const fromHeader = (raw) => headerFields(raw).find((f) => f.name === "from")?.value;
const authOf = (raw) => authFromRaw(raw, fromHeader(raw));

describe("sender authentication: the hostile emails in test/fixtures/hostile", () => {
  it("reads Cloudflare's verdict, not a contradicting copy the sender put below it", () => {
    expect(authOf(cloudflarePass)).toEqual({
      result: "verified",
      dmarc: "pass",
      spf: "pass",
      dkim: "pass",
      fromDomain: "app.example.com",
    });
  });

  it("ignores a forged result just below Cloudflare's block when Cloudflare added none", () => {
    expect(authOf(forgedBelow).result).toBe("unknown");
  });

  it("ignores a forged result and score header when Cloudflare's own ARC copy disagrees", () => {
    expect(authOf(forgedResultAndScore).result).toBe("unknown");
  });

  it("is unknown without Cloudflare's block at the top", () => {
    expect(authOf(noCloudflareBlock)).toMatchObject({ result: "unknown", dmarc: null });
  });

  it("is unverified when the From domain publishes no DMARC policy", () => {
    expect(authOf(dmarcNone)).toMatchObject({ result: "unverified", dmarc: "none" });
  });

  it("is failed when DMARC failed", () => {
    expect(authOf(dmarcFail)).toMatchObject({ result: "failed", dmarc: "fail" });
  });

  it("is unknown when DMARC passed for a domain other than the visible From's", () => {
    expect(authOf(dmarcPassOtherDomain)).toMatchObject({ result: "unknown", dmarc: "pass" });
  });

  it("is unknown with two results inside Cloudflare's block", () => {
    expect(authOf(twoResults).result).toBe("unknown");
  });

  it("never counts a comment that looks like a pass", () => {
    expect(authOf(commentLooksLikePass)).toMatchObject({ result: "failed", dmarc: "fail", spf: "fail", dkim: "fail" });
  });

  it("takes the From address, never a fake one in its display name", () => {
    expect(headerFromAddress(fromHeader(displayNameInjection))).toBe("attacker@evil.example");
    expect(authOf(displayNameInjection)).toMatchObject({ result: "verified", fromDomain: "evil.example" });
  });

  it("shows a lookalike From domain in its xn-- form", () => {
    const address = headerFromAddress(fromHeader(lookalikeFrom));
    expect(address).toMatch(/^noreply@xn--/);
    expect(authOf(lookalikeFrom)).toMatchObject({ result: "unverified", fromDomain: address.split("@")[1] });
  });
});

describe("sender authentication: the pieces", () => {
  it("joins folded header lines and lower-cases names", () => {
    const fields = headerFields("Received: a\r\n\tb\r\nSubject: hi\r\n\r\nbody: not a header");
    expect(fields).toEqual([
      { name: "received", value: "a b" },
      { name: "subject", value: "hi" },
    ]);
  });

  it("parses results with properties, comments and an ARC instance tag", () => {
    expect(parseAuthResults("i=2; mx.cloudflare.net 1; dkim=pass (good sig) header.d=a.example; dmarc=none header.from=a.example")).toEqual({
      authserv: "mx.cloudflare.net",
      methods: [
        { method: "dkim", result: "pass", props: { "header.d": "a.example" } },
        { method: "dmarc", result: "none", props: { "header.from": "a.example" } },
      ],
    });
    expect(parseAuthResults("mx.cloudflare.net; none").methods).toEqual([]);
  });

  it("reads addresses without display names, comments or quoted text", () => {
    expect(headerFromAddress("Example App <NoReply@App.Example.com>")).toBe("noreply@app.example.com");
    expect(headerFromAddress("noreply@app.example.com (Example App)")).toBe("noreply@app.example.com");
    expect(headerFromAddress('"a@b.example" <c@d.example>')).toBe("c@d.example");
    expect(headerFromAddress("Example App")).toBeNull();
    expect(headerFromAddress(null)).toBeNull();
  });

  it("writes domains in their ASCII form, or null", () => {
    expect(asciiDomain("App.Example.COM.")).toBe("app.example.com");
    expect(asciiDomain("bücher.example")).toBe("xn--bcher-kva.example");
    expect(asciiDomain("not a domain")).toBeNull();
    expect(asciiDomain("")).toBeNull();
  });
});
