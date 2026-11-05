import { describe, expect, test } from "bun:test";
import { redactTarget } from "../../src/lib/redact";

describe("redactTarget", () => {
  test("flags with a value, flags with =, and NAME=value assignments", () => {
    const r = redactTarget("npx -y server --api-key abc123 --token=xyz789 GITHUB_TOKEN=t0ken run");
    expect(r.target).toBe("npx -y server --api-key ${API_KEY} --token=${TOKEN} GITHUB_TOKEN=${GITHUB_TOKEN} run");
    expect(r.secrets).toEqual([
      { name: "API_KEY", value: "abc123" },
      { name: "TOKEN", value: "xyz789" },
      { name: "GITHUB_TOKEN", value: "t0ken" },
    ]);
  });

  test("bare values with known token prefixes, and Bearer tokens", () => {
    const r = redactTarget("mcp-remote https://x.example/mcp --header Authorization: Bearer abc.def ghp_0000000000example");
    expect(r.target).toBe("mcp-remote https://x.example/mcp --header Authorization: Bearer ${BEARER_TOKEN} ${TOKEN}");
    expect(r.secrets.map((s) => s.name)).toEqual(["BEARER_TOKEN", "TOKEN"]);
  });

  test("URLs: secret-named query parameters, a password and token-like path segments", () => {
    const r = redactTarget("https://me:hunter2@mcp.example.com/v1/sk-0000000000example/sse?api_key=k1&team=core&access_token=k2");
    expect(r.target).toBe("https://me:${URL_PASSWORD}@mcp.example.com/v1/${TOKEN}/sse?api_key=${API_KEY}&team=core&access_token=${ACCESS_TOKEN}");
    expect(r.secrets.map((s) => s.value)).toEqual(["hunter2", "sk-0000000000example", "k1", "k2"]);
  });

  test("leaves plain targets, placeholders and non-secret flags alone", () => {
    for (const t of ["consult-mcp --stdio", "https://mcp.linear.app/sse", "server --api-key ${API_KEY}", "server --port 8080 --keyboard yes"]) {
      expect(redactTarget(t)).toEqual({ target: t, secrets: [] });
    }
  });

  test("names stay unique", () => {
    const r = redactTarget("a --token one --token two");
    expect(r.target).toBe("a --token ${TOKEN} --token ${TOKEN_2}");
  });
});
