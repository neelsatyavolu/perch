import { describe, expect, test } from "bun:test";
import { PRIVATE_URL_PATTERNS, isPrivateHost, mayPreview, parseMeta } from "../../src/preview/meta";

describe("parseMeta", () => {
  test("prefers Open Graph, falls back to Twitter and plain tags, and resolves the image", () => {
    const html = `<html><head>
      <title>Plain &amp; title</title>
      <meta name="description" content="Plain description">
      <meta property="og:title" content="OG &quot;title&quot;">
      <meta content="/img/card.png" property="og:image">
      <meta property='og:site_name' content='Example News'>
      <meta name="twitter:description" content="Twitter description">
    </head><body></body></html>`;
    expect(parseMeta(html, "https://news.example/a/b")).toEqual({
      title: 'OG "title"',
      description: "Twitter description",
      image: "https://news.example/img/card.png",
      siteName: "Example News",
    });
  });

  test("plain title and description when there is no Open Graph", () => {
    const meta = parseMeta("<title>\n  Hello  world </title><meta name=description content='A page'>", "https://a.example/");
    expect(meta).toEqual({ title: "Hello world", description: "A page", image: null, siteName: "a.example" });
  });

  test("drops non-http images and trims very long text", () => {
    const meta = parseMeta(`<meta property="og:image" content="javascript:alert(1)"><title>${"x".repeat(500)}</title>`, "https://a.example/");
    expect(meta.image).toBeNull();
    expect(meta.title!.length).toBeLessThanOrEqual(200);
  });

  test("decodes numeric entities", () => {
    expect(parseMeta("<title>caf&#233; &#x2014; menu</title>", "https://a.example/").title).toBe("café — menu");
  });
});

describe("address guard", () => {
  test("recognises loopback, private and link-local hosts", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "[::1]", "[fd00::1]", "0.0.0.0", "router.local"]) {
      expect(isPrivateHost(host)).toBe(true);
    }
    for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "[2001:db8::1]"]) expect(isPrivateHost(host)).toBe(false);
  });

  test("a public page may only preview public links; a private page may preview its own network", () => {
    expect(mayPreview("https://news.example/", "http://192.168.1.1/admin")).toBe(false);
    expect(mayPreview("https://news.example/", "https://other.example/")).toBe(true);
    expect(mayPreview("http://site.localhost:3000/", "http://other.localhost:3000/a")).toBe(true);
    expect(mayPreview("https://news.example/", "file:///etc/passwd")).toBe(false);
  });

  test("trailing dots, single-label names and intranet suffixes count as private", () => {
    for (const host of ["localhost.", "x.localhost.", "nas.local.", "router", "nas", "router.", "printer.lan", "box.home.arpa", "wiki.corp", "intranet", "db.internal."]) {
      expect(isPrivateHost(host)).toBe(true);
    }
    for (const link of ["http://localhost./", "http://x.localhost.:8080/a", "http://router/", "http://nas:5000/", "http://nas.local./", "https://printer.lan/"]) {
      expect(mayPreview("https://news.example/", link)).toBe(false);
    }
    expect(mayPreview("https://news.example/", "https://example.com./")).toBe(true);
  });
});

describe("network guard patterns", () => {
  const guarded = (url: string) => PRIVATE_URL_PATTERNS.some((p) => new RegExp(p, "i").test(new URL(url).href));

  test("match every private address class isPrivateHost knows, as Chrome writes the URL", () => {
    const urls = [
      "http://localhost/", "http://localhost.:8080/x", "http://app.localhost:3000/", "http://router/", "http://nas:5000/a?b",
      "http://nas.local./", "https://printer.lan/", "http://box.home.arpa/", "http://127.0.0.1/", "http://0x7f.1/", "http://2130706433/",
      "http://10.0.0.8:9/", "http://172.20.1.1/", "http://192.168.1.1/admin", "http://169.254.169.254/latest", "http://100.64.0.1/",
      "http://[::1]:7000/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://user:pw@router/",
    ];
    for (const url of urls) {
      expect(isPrivateHost(new URL(url).hostname)).toBe(true);
      expect(guarded(url)).toBe(true);
    }
  });

  test("leave public addresses alone", () => {
    for (const url of ["https://example.com/", "https://example.com./a", "http://8.8.8.8/", "http://172.32.0.1/", "http://[2001:db8::1]/", "https://local.example.com/", "https://lan.example/x"]) {
      expect(isPrivateHost(new URL(url).hostname)).toBe(false);
      expect(guarded(url)).toBe(false);
    }
  });
});
