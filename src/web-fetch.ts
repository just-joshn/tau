import { STATUS_CODES } from "node:http";
import { z } from "zod";
import { htmlToMarkdown } from "./web-markdown.js";

export const WEB_FETCH_TOOL = "WebFetch";
/** Original t1s/Tas/Cas/sfn limits (chunk-4h798pp0, chunk-ytvh0vqm). */
export const webFetchLimits = Object.freeze({
  maxUrlLength: 2000,
  maxResponseBytes: 10 * 1024 * 1024,
  requestTimeoutMs: 60_000,
  preflightTimeoutMs: 10_000,
  maxRedirects: 10,
  markdownInputChars: 1024 * 1024,
  modelContentChars: 100_000,
  cacheTtlMs: 15 * 60_000,
  cacheBytes: 50 * 1024 * 1024,
  domainCheckTtlMs: 5 * 60_000,
});
const TRUNCATED = "\n\n[Content truncated due to length...]";
const PREFLIGHT_URL = "https://api.anthropic.com/api/web/domain_info";

export const webFetchInputSchema = z.strictObject({
  url: z.url().describe("The URL to fetch content from"),
  prompt: z.string().describe("The prompt to run on the fetched content"),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Character position in the page text to start reading from. Use it to read on through a page too long for one call, with the value the previous result gave.",
    ),
});
export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
export interface WebFetchOutput {
  bytes: number;
  code: number;
  codeText: string;
  result: string;
  durationMs: number;
  url: string;
}
interface Page {
  type: "page";
  content: string;
  bytes: number;
  code: number;
  codeText: string;
  contentType: string;
}
/** Cas/zHe outcomes: a page, a redirect it will not follow, or a non-2xx status. */
export type FetchOutcome =
  | Page
  | {
      type: "redirect";
      originalUrl: string;
      redirectUrl: string;
      statusCode: number;
    }
  | { type: "http_error"; statusCode: number; retryAfter?: string };

export class WebFetchError extends Error {
  override name = "WebFetchError";
}

/** Original eas: docs hosts and path prefixes that skip the permission prompt. */
const PREAPPROVED = [
  "platform.claude.com",
  "code.claude.com",
  "claude.dev",
  "www.claude.dev",
  "claude.com/docs",
  "modelcontextprotocol.io",
  "github.com/anthropics",
  "github.com/anthropic-experimental",
  "raw.githubusercontent.com/anthropics",
  "raw.githubusercontent.com/anthropic-experimental",
  "agentskills.io",
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev/doc",
  "go.dev/ref",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",
  "laravel.com",
  "symfony.com",
  "wordpress.org/documentation",
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",
  "asp.net",
  "dotnet.microsoft.com",
  "blazor.net",
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",
  "keras.io",
  "spark.apache.org",
  "huggingface.co/docs",
  "www.kaggle.com/docs",
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",
  "docs.getdbt.com",
  "docs.aws.amazon.com",
  "cloud.google.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "vercel.com/docs",
  "docs.stripe.com",
  "docs.netlify.com",
  "devcenter.heroku.com",
  "dev.wix.com/docs",
  "cypress.io",
  "selenium.dev",
  "docs.unity.com",
  "docs.unrealengine.com",
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
];
const preapprovedHosts = new Set<string>();
const preapprovedPaths = new Map<string, string[]>();
for (const entry of PREAPPROVED) {
  const slash = entry.indexOf("/");
  if (slash === -1) preapprovedHosts.add(entry);
  else {
    const host = entry.slice(0, slash);
    preapprovedPaths.set(host, [
      ...(preapprovedPaths.get(host) ?? []),
      entry.slice(slash),
    ]);
  }
}
/** Original ras/sas: GitHub prefixes cover only main-branch content. */
function githubPathAllowed(host: string, path: string): boolean {
  return host === "raw.githubusercontent.com"
    ? /^\/[^/]+\/[^/]+\/refs\/heads\/main\/./.test(path)
    : /^\/[^/]+\/[^/]+(\/?|\/(tree|blob)\/main(\/.*)?)$/.test(path);
}
/** Original jHe. */
export function isPreapprovedHost(host: string, path: string): boolean {
  if (preapprovedHosts.has(host)) return true;
  const prefixes = preapprovedPaths.get(host);
  if (!prefixes || /%(25)*(2f|5c|2e)/i.test(path)) return false;
  return prefixes.some(
    (prefix) =>
      (path === prefix || path.startsWith(prefix + "/")) &&
      (!["github.com", "raw.githubusercontent.com"].includes(host) ||
        host + prefix === "github.com/anthropics" ||
        githubPathAllowed(host, path)),
  );
}
export function isPreapprovedUrl(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed !== null && isPreapprovedHost(parsed.hostname, parsed.pathname);
}

/** Original ISt: the permission rule content for a WebFetch input. */
export function webFetchRuleContent(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? `domain:${parsed.hostname}` : `input:${url}`;
}
/** Original l(): case-fold the host and drop a trailing root dot. */
function normalizeDomainContent(content: string): string {
  return content.startsWith("domain:")
    ? `domain:${content
        .slice(7)
        .toLowerCase()
        .replace(/(?<=[^*.])\.+(?=(:\d+)?$)/, "")}`
    : content;
}
/** Original qcr/vx: label-wise `*` glob where `.` and `:` separate labels. */
function labelsMatch(pattern: string, value: string): boolean {
  const patternLabels = pattern.split(/[.:]/),
    valueLabels = value.split(/[.:]/);
  const separators = (text: string) => text.replace(/[^.:]/g, "");
  if (
    patternLabels.length !== valueLabels.length ||
    separators(pattern) !== separators(value)
  )
    return false;
  return patternLabels.every((label, index) => {
    const candidate = valueLabels[index] ?? "";
    const pieces = label.split("*");
    if (pieces.length === 1) return label === candidate;
    const first = pieces[0] ?? "",
      last = pieces.at(-1) ?? "";
    if (
      !candidate.startsWith(first) ||
      !candidate.endsWith(last) ||
      candidate.length < first.length + last.length
    )
      return false;
    let cursor = first.length;
    for (const piece of pieces.slice(1, -1)) {
      const found = candidate.indexOf(piece, cursor);
      if (found === -1 || found + piece.length > candidate.length - last.length)
        return false;
      cursor = found + piece.length;
    }
    return true;
  });
}
/** Original lct/f: exact content first, then `domain:*` and `domain:*.suffix` wildcards. */
export function matchesDomainRule(rule: string, content: string): boolean {
  const pattern = normalizeDomainContent(rule),
    value = normalizeDomainContent(content);
  if (!pattern.includes("*")) return pattern === value;
  if (!pattern.startsWith("domain:") || !value.startsWith("domain:"))
    return false;
  if (pattern === "domain:*") return true;
  const host = pattern.slice(7),
    candidate = value.slice(7);
  if (!host.startsWith("*.")) return labelsMatch(host, candidate);
  const suffix = host.slice(2);
  let wanted = 1 + suffix.replace(/[^.:]/g, "").length,
    cut = candidate.length;
  while (wanted > 0 && cut > 0) {
    cut--;
    if (".:".includes(candidate.charAt(cut))) wanted--;
  }
  const head = candidate.slice(0, cut + 1);
  return (
    wanted === 0 &&
    !head.startsWith(".") &&
    !head.includes("..") &&
    !head.includes(":") &&
    labelsMatch(suffix, candidate.slice(cut + 1))
  );
}

/** Original Tas plus the dotless-host refusal in t1s. */
export function checkFetchableUrl(url: string): void {
  const parsed =
    url.length > webFetchLimits.maxUrlLength ? null : URL.parse(url);
  if (
    parsed &&
    !parsed.username &&
    !parsed.password &&
    parsed.hostname.split(".").length >= 2
  )
    return;
  const host = URL.parse(url)?.hostname;
  if (host && !host.includes("."))
    throw new WebFetchError(
      "WebFetch cannot fetch localhost or other hostnames without a dot. To reach a local server, use Bash with curl instead.",
    );
  throw new WebFetchError("Invalid URL");
}
/** Original Ujn: follow only same-protocol, same-port, www-insensitive same-host redirects. */
export function isPermittedRedirect(from: string, to: string): boolean {
  const source = URL.parse(from),
    target = URL.parse(to);
  if (!source || !target) return false;
  const bare = (host: string) => host.replace(/^www\./, "");
  const host = bare(source.hostname);
  const hosts = [source.hostname, host, `www.${host}`];
  if (
    hosts.some((name) => isPreapprovedHost(name, source.pathname)) &&
    !hosts.some((name) => isPreapprovedHost(name, target.pathname))
  )
    return false;
  return (
    target.protocol === source.protocol &&
    target.port === source.port &&
    !target.username &&
    !target.password &&
    bare(target.hostname) === host
  );
}

export function statusText(code: number): string {
  return STATUS_CODES[code] ?? "Unknown Status";
}

/** Original yOa: the user turn sent to the secondary model. */
export function applyPromptText(
  content: string,
  prompt: string,
  preapproved: boolean,
): string {
  const instructions = preapproved
    ? "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed."
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`;
  return `
Web page content:
---
${content}
---

${prompt}

${instructions}
`;
}

/** Original Er (redirect branch of call): the notice returned instead of following a cross-host redirect. */
export function redirectNotice(
  outcome: Extract<FetchOutcome, { type: "redirect" }>,
  prompt: string,
  offset: number,
): string {
  const target = URL.parse(outcome.redirectUrl);
  const web = target?.protocol === "https:" || target?.protocol === "http:";
  const full = web
    ? `${target.origin}${target.pathname}${target.search}${target.hash}`
    : "";
  const shown = !web ? undefined : full.slice(0, 1000);
  const withheld = full.length - (shown?.length ?? 0);
  const longHost = web && target.hostname.length > 255;
  const location =
    shown === undefined
      ? "Redirect URL: (withheld — the server sent a redirect target that is not a valid http(s) URL)"
      : `Redirect URL (from the server's Location header — server-supplied, not verified): ${shown}${withheld > 0 ? ` […${withheld} more characters withheld: too long to relay]` : ""}${longHost ? " [hostname longer than any DNS name (255 characters): not a fetchable address]" : ""}`;
  const relayable = shown !== undefined && withheld === 0 && !longHost;
  const next = relayable
    ? `To complete your request, I need to fetch content from the redirected URL. Please use ${WEB_FETCH_TOOL} again with these parameters:
    - url: "${shown}"
    - prompt: "${prompt}"${offset > 0 ? `\n    - offset: ${offset}` : ""}`
    : "The redirect target could not be relayed in full or is not a fetchable address, so it cannot be fetched from here; report the redirect instead.";
  return `REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.

    Original URL: ${outcome.originalUrl}
    ${location}
    Status: ${outcome.statusCode} ${statusText(outcome.statusCode)}

    ${next}`;
}
/** Original Oas. */
export function httpErrorNotice(
  outcome: Extract<FetchOutcome, { type: "http_error" }>,
): string {
  return `The server returned HTTP ${outcome.statusCode} ${statusText(outcome.statusCode)}.${outcome.retryAfter ? `\nRetry-After: ${outcome.retryAfter}` : ""}

The response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. \`gh\` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.`;
}

export interface WebFetchHost {
  /** Settings `skipWebFetchPreflight`; read per call like the original Hr(). */
  skipPreflight(): boolean;
  /** Secondary small-model call; returns the model's text answer. */
  applyPrompt(userPrompt: string, signal: AbortSignal): Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  preflightUrl?: string;
  userAgent?: string;
  now?: () => number;
}

interface CacheEntry {
  page: Page;
  size: number;
  storedAt: number;
}

export function createWebFetch(host: WebFetchHost) {
  const request = host.fetch ?? fetch;
  const now = host.now ?? Date.now;
  const userAgent =
    host.userAgent ?? "Claude-User (tau; +https://support.anthropic.com/)";
  const ttl = (() => {
    const configured = Number(process.env.CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS);
    return Number.isFinite(configured) && configured >= 0
      ? configured
      : webFetchLimits.cacheTtlMs;
  })();
  const pages = new Map<string, CacheEntry>();
  const domainChecks = new Map<string, number>();

  function cached(url: string): Page | undefined {
    const entry = pages.get(url);
    if (!entry) return undefined;
    if (now() - entry.storedAt > ttl) {
      pages.delete(url);
      return undefined;
    }
    pages.delete(url);
    pages.set(url, entry);
    return entry.page;
  }
  function remember(url: string, page: Page, size: number): void {
    pages.delete(url);
    pages.set(url, { page, size: Math.max(1, size), storedAt: now() });
    let total = 0;
    for (const entry of pages.values()) total += entry.size;
    for (const [key, entry] of pages) {
      if (total <= webFetchLimits.cacheBytes) break;
      pages.delete(key);
      total -= entry.size;
    }
  }

  /** Original Eas: a 200 with can_fetch true allows; anything else blocks or fails the check. */
  async function preflight(hostname: string, signal: AbortSignal) {
    const checkedAt = domainChecks.get(hostname);
    if (
      checkedAt !== undefined &&
      now() - checkedAt <= webFetchLimits.domainCheckTtlMs
    )
      return;
    let status: number;
    let allowed = false;
    try {
      const response = await request(
        `${host.preflightUrl ?? PREFLIGHT_URL}?domain=${encodeURIComponent(hostname)}`,
        {
          headers: { "User-Agent": userAgent },
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(webFetchLimits.preflightTimeoutMs),
          ]),
        },
      );
      status = response.status;
      if (status === 200) {
        const body: unknown = await response.json().catch(() => undefined);
        allowed = z
          .object({ can_fetch: z.literal(true) })
          .safeParse(body).success;
      } else await response.body?.cancel();
    } catch (error) {
      signal.throwIfAborted();
      throw new WebFetchError(
        `Unable to verify if domain ${hostname} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking claude.ai.`,
        { cause: error },
      );
    }
    if (status === 200 && allowed) {
      domainChecks.set(hostname, now());
      return;
    }
    if (status === 200)
      throw new WebFetchError(
        `Claude Code is unable to fetch from ${hostname}`,
      );
    throw new WebFetchError(
      status === 429
        ? `The safety check for domain ${hostname} is rate-limited (too many domain checks from this network; the limit is shared and can stay exhausted for minutes). Do not retry ${WEB_FETCH_TOOL} in a loop or sleep to wait it out; continue without this page and report that its safety check was rate-limited. A single later attempt is fine; if that is rate-limited too, stop.`
        : `Unable to verify if domain ${hostname} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking claude.ai.`,
    );
  }

  async function readBounded(response: Response): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (!response.body) return Buffer.alloc(0);
    const body: ReadableStream<Uint8Array> = response.body,
      reader = body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return Buffer.concat(chunks);
        total += chunk.value.byteLength;
        if (total > webFetchLimits.maxResponseBytes)
          throw new WebFetchError(
            `maxContentLength size of ${webFetchLimits.maxResponseBytes} exceeded`,
          );
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /** Original Cas/zHe: manual redirects, permitted ones followed up to the redirect cap. */
  async function retrieve(
    url: string,
    signal: AbortSignal,
    hops = 0,
  ): Promise<FetchOutcome> {
    if (hops > webFetchLimits.maxRedirects)
      throw new WebFetchError(
        `Too many redirects (exceeded ${webFetchLimits.maxRedirects})`,
      );
    let response: Response;
    try {
      response = await request(url, {
        redirect: "manual",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(webFetchLimits.requestTimeoutMs),
        ]),
        headers: {
          Accept: "text/markdown, text/html, */*",
          "User-Agent": userAgent,
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new WebFetchError(
        error instanceof Error ? error.message : "Fetch failed",
        { cause: error },
      );
    }
    const code = response.status;
    if (code >= 200 && code < 300) {
      const data = await readBounded(response);
      const contentType = response.headers.get("content-type") ?? "";
      const text = data.toString("utf8");
      return {
        type: "page",
        content: contentType.includes("text/html")
          ? await htmlToMarkdown(text, webFetchLimits.markdownInputChars)
          : text,
        bytes: data.byteLength,
        code,
        codeText: response.statusText || statusText(code),
        contentType,
      };
    }
    await response.body?.cancel().catch(() => {});
    if ([301, 302, 303, 307, 308].includes(code)) {
      const location = response.headers.get("location");
      const target =
        location && location.trim() !== ""
          ? URL.parse(location, url)?.toString()
          : undefined;
      if (target === undefined) return { type: "http_error", statusCode: code };
      return isPermittedRedirect(url, target)
        ? retrieve(target, signal, hops + 1)
        : {
            type: "redirect",
            originalUrl: url,
            redirectUrl: target,
            statusCode: code,
          };
    }
    const retryAfter = response.headers.get("retry-after");
    return {
      type: "http_error",
      statusCode: code,
      ...(retryAfter && /^[0-9]{1,6}$/.test(retryAfter) ? { retryAfter } : {}),
    };
  }

  /** Original t1s: validate, cache by requested URL, upgrade to https, preflight, retrieve. */
  async function load(url: string, signal: AbortSignal): Promise<FetchOutcome> {
    checkFetchableUrl(url);
    const hit = cached(url);
    if (hit) return hit;
    const target = new URL(url);
    if (target.protocol === "http:") target.protocol = "https:";
    if (!host.skipPreflight()) await preflight(target.hostname, signal);
    const outcome = await retrieve(target.toString(), signal);
    if (outcome.type === "page")
      remember(
        url,
        outcome,
        outcome.contentType.includes("text/html")
          ? Buffer.byteLength(outcome.content)
          : outcome.bytes,
      );
    return outcome;
  }

  /** Original lw.call for the main-thread path: fetch, then answer `prompt` with the secondary model. */
  async function run(
    input: WebFetchInput,
    signal: AbortSignal,
  ): Promise<WebFetchOutput> {
    const started = now();
    const offset = input.offset ?? 0;
    const outcome = await load(input.url, signal);
    const done = (fields: Omit<WebFetchOutput, "durationMs" | "url">) => ({
      ...fields,
      durationMs: now() - started,
      url: input.url,
    });
    if (outcome.type === "http_error")
      return done({
        bytes: 0,
        code: outcome.statusCode,
        codeText: statusText(outcome.statusCode),
        result: httpErrorNotice(outcome),
      });
    if (outcome.type === "redirect") {
      const result = redirectNotice(outcome, input.prompt, offset);
      return done({
        bytes: Buffer.byteLength(result),
        code: outcome.statusCode,
        codeText: statusText(outcome.statusCode),
        result,
      });
    }
    const { content } = outcome;
    const rest = content.slice(offset);
    const preapproved = isPreapprovedUrl(input.url);
    let result: string;
    if (offset > 0 && rest === "")
      result = `Nothing left to read from offset ${offset}: this page's text is ${content.length} characters long.`;
    else if (
      preapproved &&
      outcome.contentType.includes("text/markdown") &&
      rest.length < webFetchLimits.modelContentChars
    )
      result = rest;
    else {
      const read = rest.slice(0, webFetchLimits.modelContentChars);
      const lead =
        offset > 0
          ? `The content below is one part of a longer page: it starts ${offset} characters into the page's ${content.length}.\n`
          : "";
      const answer = await host.applyPrompt(
        lead +
          applyPromptText(
            read.length < rest.length ? read + TRUNCATED : rest,
            input.prompt,
            preapproved,
          ),
        signal,
      );
      if (answer.trim() === "")
        throw new WebFetchError(
          "The small, fast model that reads the content gave no answer. Trying again may work.",
        );
      const end = offset + read.length;
      result =
        end < content.length
          ? `${answer}\n\n[${WEB_FETCH_TOOL} note: this page's text is ${content.length} characters long and the answer above covers only characters ${offset} to ${end}; the final ${content.length - end} were not read — to read on, call ${WEB_FETCH_TOOL} again with the same url and offset: ${end}.]`
          : answer;
    }
    return done({
      bytes: outcome.bytes,
      code: outcome.code,
      codeText: outcome.codeText,
      result,
    });
  }
  return { run, clear: () => (pages.clear(), domainChecks.clear()) };
}

/** Original bT(): the secondary model for WebFetch's prompt step. */
export function webFetchModel(
  mainModel: string,
  env: NodeJS.ProcessEnv,
  haiku: string,
): string {
  if (env.ANTHROPIC_SMALL_FAST_MODEL) return env.ANTHROPIC_SMALL_FAST_MODEL;
  if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
    return env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  const key = env.ANTHROPIC_API_KEY ?? "";
  return !env.ANTHROPIC_AUTH_TOKEN &&
    key.startsWith("sk-ant-") &&
    key.slice(7, 10) === "api"
    ? haiku
    : mainModel;
}

/** Original g() with the "none" artifact surface, non-lean prompt. */
export function webFetchDescription(): string {
  const minutes = Math.max(
    1,
    Math.round(
      (Number(process.env.CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS) ||
        webFetchLimits.cacheTtlMs) / 60_000,
    ),
  );
  return `IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.

- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - localhost and other hostnames without a dot are not supported; for a local server, use curl via Bash
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning cache (entries expire after ${minutes} ${minutes === 1 ? "minute" : "minutes"}) for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
`;
}
