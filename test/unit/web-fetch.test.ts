import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import {
  applyPromptText,
  checkFetchableUrl,
  createWebFetch,
  httpErrorNotice,
  isPermittedRedirect,
  isPreapprovedHost,
  matchesDomainRule,
  redirectNotice,
  statusText,
  WebFetchError,
  webFetchDescription,
  webFetchInputSchema,
  webFetchModel,
  webFetchRuleContent,
  type WebFetchHost,
} from "../../src/web-fetch.js";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function host(
  route: Route,
  overrides: Partial<WebFetchHost> = {},
): {
  host: WebFetchHost;
  calls: string[];
  prompts: string[];
} {
  const calls: string[] = [],
    prompts: string[] = [];
  return {
    calls,
    prompts,
    host: {
      skipPreflight: () => true,
      applyPrompt: async (prompt) => {
        prompts.push(prompt);
        return "ANSWER";
      },
      fetch: async (url, init) => {
        calls.push(url);
        return route(url, init);
      },
      ...overrides,
    },
  };
}
const signal = () => new AbortController().signal;
const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html" } });
afterEach(() => {
  delete process.env.CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS;
});

test("URL policy refuses dotless hosts, credentials and oversized URLs", () => {
  assert.throws(
    () => checkFetchableUrl("http://localhost:3000/x"),
    /cannot fetch localhost or other hostnames without a dot/,
  );
  assert.throws(
    () => checkFetchableUrl("https://user:pw@example.com/"),
    /^WebFetchError: Invalid URL$/,
  );
  assert.throws(
    () => checkFetchableUrl("https://example.com/" + "a".repeat(2000)),
    /Invalid URL/,
  );
  assert.throws(() => checkFetchableUrl("not a url"), /Invalid URL/);
  assert.doesNotThrow(() => checkFetchableUrl("http://127.0.0.1:9/x"));
});

test("preapproved hosts and path prefixes follow the original table", () => {
  assert.equal(isPreapprovedHost("docs.python.org", "/3/"), true);
  assert.equal(isPreapprovedHost("go.dev", "/doc/effective"), true);
  assert.equal(isPreapprovedHost("go.dev", "/play"), false);
  assert.equal(isPreapprovedHost("go.dev", "/doc%2f..%2fx"), false);
  assert.equal(isPreapprovedHost("github.com", "/anthropics/x/issues"), true);
  assert.equal(
    isPreapprovedHost("github.com", "/anthropic-experimental/repo"),
    true,
  );
  assert.equal(
    isPreapprovedHost("github.com", "/anthropic-experimental/repo/pulls"),
    false,
  );
  assert.equal(
    isPreapprovedHost(
      "raw.githubusercontent.com",
      "/anthropics/r/refs/heads/main/README.md",
    ),
    true,
  );
  assert.equal(
    isPreapprovedHost("raw.githubusercontent.com", "/anthropics/r/dev/x"),
    false,
  );
  assert.equal(isPreapprovedHost("example.com", "/"), false);
});

test("domain rules match exact, case-folded, root-dotted and wildcard hosts", () => {
  assert.equal(
    webFetchRuleContent("https://Example.com/a"),
    "domain:example.com",
  );
  assert.equal(webFetchRuleContent("nope"), "input:nope");
  assert.equal(
    matchesDomainRule("domain:EXAMPLE.com.", "domain:example.com"),
    true,
  );
  assert.equal(
    matchesDomainRule("domain:other.com", "domain:example.com"),
    false,
  );
  assert.equal(matchesDomainRule("domain:*", "domain:anything.test"), true);
  assert.equal(
    matchesDomainRule("domain:*.example.com", "domain:a.example.com"),
    true,
  );
  assert.equal(
    matchesDomainRule("domain:*.example.com", "domain:a.b.example.com"),
    true,
  );
  assert.equal(
    matchesDomainRule("domain:*.example.com", "domain:example.com"),
    false,
  );
  assert.equal(
    matchesDomainRule("domain:*.example.com", "domain:a:1.example.com"),
    false,
  );
  assert.equal(
    matchesDomainRule("domain:docs.*.com", "domain:docs.x.com"),
    true,
  );
  assert.equal(
    matchesDomainRule("domain:docs.*.com", "domain:docs.x.y.com"),
    false,
  );
  assert.equal(matchesDomainRule("domain:a*b*c.com", "domain:axbyc.com"), true);
  assert.equal(matchesDomainRule("domain:a*b*c.com", "domain:axyc.com"), false);
  assert.equal(matchesDomainRule("domain:a*z.com", "domain:b.com"), false);
  assert.equal(matchesDomainRule("domain:a*.com", "domain:a.com:9"), false);
  assert.equal(matchesDomainRule("input:*", "domain:x.com"), false);
});

test("redirects are followed only within the same host, protocol and port", () => {
  assert.equal(
    isPermittedRedirect("https://a.com/x", "https://www.a.com/y"),
    true,
  );
  assert.equal(
    isPermittedRedirect("https://a.com/x", "https://b.com/y"),
    false,
  );
  assert.equal(isPermittedRedirect("https://a.com/x", "http://a.com/y"), false);
  assert.equal(
    isPermittedRedirect("https://a.com/x", "https://a.com:8/y"),
    false,
  );
  assert.equal(
    isPermittedRedirect("https://a.com/x", "https://u:p@a.com/y"),
    false,
  );
  assert.equal(isPermittedRedirect("https://a.com/x", "::"), false);
  assert.equal(
    isPermittedRedirect("https://go.dev/doc/x", "https://go.dev/play"),
    false,
  );
});

test("notices and prompt text keep the original wording", () => {
  assert.equal(statusText(999), "Unknown Status");
  assert.match(
    httpErrorNotice({ type: "http_error", statusCode: 503, retryAfter: "5" }),
    /^The server returned HTTP 503 Service Unavailable\.\nRetry-After: 5\n\nThe response body was not retrieved\./,
  );
  const notice = redirectNotice(
    {
      type: "redirect",
      originalUrl: "https://a.com/",
      redirectUrl: "https://b.com/p?q#h",
      statusCode: 301,
    },
    "summarize",
    7,
  );
  assert.match(
    notice,
    /Original URL: https:\/\/a\.com\/\n    Redirect URL \(from the server's Location header — server-supplied, not verified\): https:\/\/b\.com\/p\?q#h\n    Status: 301 Moved Permanently/,
  );
  assert.match(
    notice,
    /- url: "https:\/\/b\.com\/p\?q#h"\n    - prompt: "summarize"\n    - offset: 7$/,
  );
  const odd = redirectNotice(
    {
      type: "redirect",
      originalUrl: "https://a.com/",
      redirectUrl: "ftp://b.com/",
      statusCode: 302,
    },
    "p",
    0,
  );
  assert.match(
    odd,
    /withheld — the server sent a redirect target that is not a valid http\(s\) URL/,
  );
  assert.match(odd, /report the redirect instead\.$/);
  const long = redirectNotice(
    {
      type: "redirect",
      originalUrl: "https://a.com/",
      redirectUrl: `https://${"h".repeat(60)}.com/${"p".repeat(1200)}`,
      statusCode: 302,
    },
    "p",
    0,
  );
  assert.match(long, /more characters withheld: too long to relay/);
  assert.match(
    applyPromptText("PAGE", "Q", true),
    /^\nWeb page content:\n---\nPAGE\n---\n\nQ\n\nProvide a concise response based on the content above\. Include relevant details/,
  );
  assert.match(applyPromptText("PAGE", "Q", false), /125-character maximum/);
});

test("description reports the cache lifetime and the model choice follows bT", () => {
  assert.match(webFetchDescription(), /entries expire after 15 minutes/);
  process.env.CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS = "60000";
  assert.match(webFetchDescription(), /entries expire after 1 minute\)/);
  assert.equal(webFetchModel("main", {}, "haiku"), "main");
  assert.equal(
    webFetchModel("main", { ANTHROPIC_SMALL_FAST_MODEL: "small" }, "haiku"),
    "small",
  );
  assert.equal(
    webFetchModel("main", { ANTHROPIC_DEFAULT_HAIKU_MODEL: "h" }, "haiku"),
    "h",
  );
  assert.equal(
    webFetchModel("main", { ANTHROPIC_API_KEY: "sk-ant-api03-x" }, "haiku"),
    "haiku",
  );
  assert.equal(
    webFetchModel(
      "main",
      { ANTHROPIC_API_KEY: "sk-ant-api03-x", ANTHROPIC_AUTH_TOKEN: "t" },
      "haiku",
    ),
    "main",
  );
  assert.equal(
    webFetchInputSchema.safeParse({ url: "x", prompt: "p" }).success,
    false,
  );
});

test("fetch upgrades to https, converts HTML, caches by URL and applies the prompt", async () => {
  const fake = host(() => html("<h1>Title</h1><p>Body</p>"));
  const tool = createWebFetch(fake.host);
  const first = await tool.run(
    { url: "http://example.com/page", prompt: "What?" },
    signal(),
  );
  assert.deepEqual(fake.calls, ["https://example.com/page"]);
  assert.equal(first.result, "ANSWER");
  assert.equal(first.code, 200);
  assert.equal(first.url, "http://example.com/page");
  assert.match(fake.prompts[0] ?? "", /Title\n=====\n\nBody/);
  await tool.run({ url: "http://example.com/page", prompt: "Again" }, signal());
  assert.equal(fake.calls.length, 1);
  tool.clear();
  await tool.run({ url: "http://example.com/page", prompt: "Again" }, signal());
  assert.equal(fake.calls.length, 2);
});

test("cache entries expire after the configured lifetime", async () => {
  let clock = 0;
  process.env.CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS = "10";
  const fake = host(() => new Response("plain"), { now: () => clock });
  const tool = createWebFetch(fake.host);
  await tool.run({ url: "https://example.com/", prompt: "p" }, signal());
  clock = 5;
  await tool.run({ url: "https://example.com/", prompt: "p" }, signal());
  clock = 50;
  await tool.run({ url: "https://example.com/", prompt: "p" }, signal());
  assert.equal(fake.calls.length, 2);
});

test("same-host redirects are followed and cross-host ones become notices", async () => {
  const fake = host((url) =>
    url.endsWith("/start")
      ? new Response(null, { status: 301, headers: { location: "/next" } })
      : url.endsWith("/next")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://other.example.org/x" },
          })
        : new Response("unreachable"),
  );
  const tool = createWebFetch(fake.host);
  const result = await tool.run(
    { url: "https://example.com/start", prompt: "p" },
    signal(),
  );
  assert.deepEqual(fake.calls, [
    "https://example.com/start",
    "https://example.com/next",
  ]);
  assert.equal(result.code, 302);
  assert.match(result.result, /^REDIRECT DETECTED/);
  assert.equal(fake.prompts.length, 0);
});

test("redirect loops, missing locations and HTTP errors are reported", async () => {
  const loop = createWebFetch(
    host(
      () =>
        new Response(null, { status: 302, headers: { location: "/again" } }),
    ).host,
  );
  await assert.rejects(
    loop.run({ url: "https://example.com/a", prompt: "p" }, signal()),
    /Too many redirects \(exceeded 10\)/,
  );
  const missing = await createWebFetch(
    host(() => new Response(null, { status: 302 })).host,
  ).run({ url: "https://example.com/a", prompt: "p" }, signal());
  assert.equal(missing.code, 302);
  assert.match(missing.result, /^The server returned HTTP 302 Found\./);
  const limited = await createWebFetch(
    host(
      () =>
        new Response("no", { status: 429, headers: { "retry-after": "30" } }),
    ).host,
  ).run({ url: "https://example.com/a", prompt: "p" }, signal());
  assert.equal(limited.bytes, 0);
  assert.match(limited.result, /HTTP 429 Too Many Requests\.\nRetry-After: 30/);
  const dated = await createWebFetch(
    host(
      () =>
        new Response("no", {
          status: 500,
          headers: { "retry-after": "Wed, 21 Oct" },
        }),
    ).host,
  ).run({ url: "https://example.com/a", prompt: "p" }, signal());
  assert.equal(dated.result.includes("Retry-After"), false);
});

test("transport failures, oversized bodies and empty answers fail the call", async () => {
  await assert.rejects(
    createWebFetch(
      host(() => {
        throw new TypeError("connect ECONNREFUSED");
      }).host,
    ).run({ url: "https://example.com/", prompt: "p" }, signal()),
    (error) =>
      error instanceof WebFetchError && /ECONNREFUSED/.test(error.message),
  );
  await assert.rejects(
    createWebFetch(
      host(() => {
        throw "odd";
      }).host,
    ).run({ url: "https://example.com/", prompt: "p" }, signal()),
    /Fetch failed/,
  );
  const big = new Uint8Array(6 * 1024 * 1024);
  await assert.rejects(
    createWebFetch(
      host(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(big);
                controller.enqueue(big);
                controller.close();
              },
            }),
          ),
      ).host,
    ).run({ url: "https://example.com/", prompt: "p" }, signal()),
    /maxContentLength size of 10485760 exceeded/,
  );
  await assert.rejects(
    createWebFetch(
      host(() => new Response("text"), { applyPrompt: async () => "  " }).host,
    ).run({ url: "https://example.com/", prompt: "p" }, signal()),
    /gave no answer/,
  );
  const empty = await createWebFetch(
    host(() => new Response(null, { status: 204 })).host,
  ).run({ url: "https://example.com/", prompt: "p" }, signal());
  assert.equal(empty.bytes, 0);
});

test("offsets read on, report the end and mark partially read pages", async () => {
  const page = "x".repeat(100_050);
  const fake = host(() => new Response(page));
  const tool = createWebFetch(fake.host);
  const first = await tool.run(
    { url: "https://example.com/", prompt: "p" },
    signal(),
  );
  assert.match(
    first.result,
    /^ANSWER\n\n\[WebFetch note: this page's text is 100050 characters long and the answer above covers only characters 0 to 100000; the final 50 were not read — to read on, call WebFetch again with the same url and offset: 100000\.\]$/,
  );
  assert.match(
    fake.prompts[0] ?? "",
    /\[Content truncated due to length\.\.\.\]/,
  );
  const rest = await tool.run(
    { url: "https://example.com/", prompt: "p", offset: 100_000 },
    signal(),
  );
  assert.equal(rest.result, "ANSWER");
  assert.match(
    fake.prompts[1] ?? "",
    /^The content below is one part of a longer page: it starts 100000 characters into the page's 100050\.\n\nWeb page content:/,
  );
  const past = await tool.run(
    { url: "https://example.com/", prompt: "p", offset: 200_000 },
    signal(),
  );
  assert.equal(
    past.result,
    "Nothing left to read from offset 200000: this page's text is 100050 characters long.",
  );
});

test("preapproved markdown is returned raw without the secondary model", async () => {
  const fake = host(
    () =>
      new Response("# Doc", { headers: { "content-type": "text/markdown" } }),
  );
  const result = await createWebFetch(fake.host).run(
    { url: "https://docs.python.org/3/", prompt: "p" },
    signal(),
  );
  assert.equal(result.result, "# Doc");
  assert.equal(fake.prompts.length, 0);
});

test("the domain preflight allows, blocks, rate-limits and caches checks", async () => {
  const answers: Record<string, () => Response> = {
    "ok.com": () => Response.json({ can_fetch: true }),
    "blocked.com": () => Response.json({ can_fetch: false }),
    "limited.com": () => new Response("slow down", { status: 429 }),
    "broken.com": () => new Response("err", { status: 500 }),
  };
  const fake = host(
    (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/web/domain_info") {
        const answer = answers[parsed.searchParams.get("domain") ?? ""];
        if (!answer) throw new Error("offline");
        return answer();
      }
      return new Response("page");
    },
    {
      skipPreflight: () => false,
      preflightUrl: "https://check.test/api/web/domain_info",
    },
  );
  const tool = createWebFetch(fake.host);
  const run = (domain: string) =>
    tool.run({ url: `https://${domain}/`, prompt: "p" }, signal());
  assert.equal((await run("ok.com")).result, "ANSWER");
  tool.clear();
  await run("ok.com");
  await assert.rejects(
    run("blocked.com"),
    /Claude Code is unable to fetch from blocked\.com/,
  );
  await assert.rejects(
    run("limited.com"),
    /safety check for domain limited\.com is rate-limited/,
  );
  await assert.rejects(
    run("broken.com"),
    /Unable to verify if domain broken\.com is safe to fetch/,
  );
  await assert.rejects(
    run("offline.com"),
    /Unable to verify if domain offline\.com is safe to fetch/,
  );
  const checks = fake.calls.filter((url) => url.includes("domain_info"));
  assert.equal(checks.filter((url) => url.endsWith("domain=ok.com")).length, 2);
  const cachedCheck = createWebFetch(fake.host);
  await cachedCheck.run({ url: "https://ok.com/a", prompt: "p" }, signal());
  await cachedCheck.run({ url: "https://ok.com/b", prompt: "p" }, signal());
  assert.equal(
    fake.calls.filter((url) => url.endsWith("domain=ok.com")).length,
    3,
  );
});

test("the page cache evicts the oldest entries past its byte budget", async () => {
  const chunk = "y".repeat(9 * 1024 * 1024);
  const fake = host(() => new Response(chunk));
  const tool = createWebFetch(fake.host);
  for (const page of [1, 2, 3, 4, 5, 6, 6, 1])
    await tool.run(
      { url: `https://example.com/${page}`, prompt: "p" },
      signal(),
    );
  assert.equal(fake.calls.length, 7);
});

test("an aborted call surfaces the abort, not a fetch error", async () => {
  const controller = new AbortController();
  const fake = host(() => {
    controller.abort();
    throw new Error("aborted underneath");
  });
  await assert.rejects(
    createWebFetch(fake.host).run(
      { url: "https://example.com/", prompt: "p" },
      controller.signal,
    ),
    (error) => !(error instanceof WebFetchError),
  );
});
