import { readdir } from "node:fs/promises";
import type { BuiltinSkillSpec } from "./types.js";
import {
  CLAUDE_API_MODEL_VARS,
  CLAUDE_API_SKILL_FILES,
  CLAUDE_API_SKILL_PROMPT,
} from "./claude-api-assets.generated.js";

/** First-token subcommands (`q`, chunk-pcxjjtda.js). Anything else is "none". */
const SUBCOMMANDS = [
  "cost-optimize",
  "latency-optimize",
  "migrate",
  "managed-agents-onboard",
  "prompt-audit",
  "upgrade",
  "api-version",
  "build-eval",
  "hillclimb",
  "preserved-thinking-migration",
  "managed-agents-secure",
] as const;

/** Detection order (`X`). An empty marker list, curl, is never chosen. */
const LANGUAGE_MARKERS: readonly (readonly [string, readonly string[]])[] = [
  [
    "python",
    [".py", "requirements.txt", "pyproject.toml", "setup.py", "Pipfile"],
  ],
  ["typescript", [".ts", ".tsx", "tsconfig.json", "package.json"]],
  ["java", [".java", "pom.xml", "build.gradle"]],
  ["go", [".go", "go.mod"]],
  ["ruby", [".rb", "Gemfile"]],
  ["csharp", [".cs", ".csproj"]],
  ["php", [".php", "composer.json"]],
];

const SECURITY_ON_DISK =
  "## Security Comparison Unavailable\n\nClaude Code cannot check the `ant` commands of `managed-agents-secure` in this session. If the request is for it, say that it is unavailable in this session and stop: do not run its `ant` commands or check the deployment by hand.";
const SECURITY_NO_DISK =
  "## Security Comparison Unavailable\n\nThe `managed-agents-secure` command follows a guide from the reference files, which are not on disk this session. If the request is for it, say that it is unavailable and stop: do not run `ant` commands or check the deployment by hand.";
const ONBOARDING_NO_DISK =
  "## Onboarding From a URL Unavailable\n\nSetting up an agent from a page (`managed-agents-onboard <url>`, or a request in plain words to copy a setup from a cookbook, post or docs page) follows `shared/managed-agents-onboarding-from-url.md`, which isn't available this session. If the request is for that, tell the user it isn't possible right now because the skill's files couldn't be saved and that running `/claude-api` again will retry saving them, then stop without fetching the page or writing any files.";

function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value);
}

function subcommand(args: string): string {
  const first = args.trim().toLowerCase().split(/\s+/)[0];
  return SUBCOMMANDS.find((name) => name === first) ?? "none";
}

/** Strip HTML comments, then fill {{NAME}} from the model table (`v`). */
function substitute(text: string): string {
  let current = text;
  let previous: string;
  do {
    previous = current;
    current = current.replace(/<!--[\s\S]*?-->\n?/g, "");
  } while (current !== previous);
  return current.replace(/\{\{(\w+)\}\}/g, (original, name: string) =>
    Object.hasOwn(CLAUDE_API_MODEL_VARS, name)
      ? (CLAUDE_API_MODEL_VARS[name] ?? original)
      : original,
  );
}

/** First language whose marker names a directory entry (`te`). */
async function detectLanguage(cwd: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(cwd);
  } catch {
    return undefined;
  }
  for (const [language, markers] of LANGUAGE_MARKERS) {
    for (const marker of markers) {
      const hit = marker.startsWith(".")
        ? entries.some((entry) => entry.endsWith(marker))
        : entries.includes(marker);
      if (hit) return language;
    }
  }
  return undefined;
}

function languageAsk(args: string, security: string): string {
  return subcommand(args) === "none"
    ? `If the request is to compare a Managed Agents deployment with the published security guide, none is needed: ${security}. Otherwise, ask the user which language they are using (see Language Detection above)`
    : "Ask the user which language they are using (see Language Detection above)";
}

/**
 * `ne` for a logged-out API-key session. Tau has no `ant` checker, so the
 * security comparison is the unavailable branch. The retiring-models scan
 * stays off, which is its shipped default.
 */
async function render(
  args: string,
  cwd: string,
  filesOnDisk: boolean,
): Promise<string> {
  const parts = [substitute(CLAUDE_API_SKILL_PROMPT).trimEnd()];
  const command = subcommand(args);
  if (!filesOnDisk) {
    const live = substitute(
      CLAUDE_API_SKILL_FILES["shared/live-sources.md"] ?? "",
    )
      .trim()
      .replace(/^(\|[^|\n]*\|[^|\n]*\|)[^|\n]*\|[ \t]*$/gm, "$1");
    parts.push(`## Reference Files Unavailable

This skill's reference files could not be written to disk for this session, so the \`{lang}/\u2026\`, \`shared/\u2026\`, and \`curl/\u2026\` files cited above cannot be Read. Do not guess their contents \u2014 fetch the matching URL from \`shared/live-sources.md\`, included below, whenever the Reading Guide points at one of those files. If a cited \`shared/\u2026\` file has no matching URL below (skill-authored guides such as \`shared/prompt-audit.md\`, \`shared/agent-design.md\`, \`shared/platform-availability.md\`), state that the reference is unavailable this session and proceed best-effort from this document.

<doc path="shared/live-sources.md">
${live}
</doc>`);
    if (command === "managed-agents-secure" || command === "none")
      parts.push(SECURITY_NO_DISK);
    parts.push(ONBOARDING_NO_DISK);
  } else parts.push(SECURITY_ON_DISK);

  const language = await detectLanguage(cwd);
  const readme = language ? `${language}/claude-api/README.md` : undefined;
  const readmeText = readme ? CLAUDE_API_SKILL_FILES[readme] : undefined;
  if (language && readme && readmeText !== undefined) {
    const onDisk = filesOnDisk
      ? " Read the other referenced files from the base directory on demand. That directory is session-scoped \u2014 after resuming a session, or if a Read under it ever fails, re-invoke this skill to re-extract."
      : "";
    parts.push(`## Detected Language: ${language}

\`${readme}\` is included below since every task starts there.${onDisk}

<doc path="${readme}">
${substitute(readmeText).trim()}
</doc>`);
  } else if (
    !language &&
    command !== "prompt-audit" &&
    command !== "managed-agents-secure"
  ) {
    const ask = languageAsk(args, "see Security Comparison Unavailable above");
    parts.push(
      filesOnDisk
        ? `No project language was auto-detected. ${ask}, then Read the matching \`{lang}/claude-api/README.md\` (or \`curl/examples.md\` for cURL/raw HTTP or an unsupported language) from the base directory before anything else.`
        : `No project language was auto-detected. ${ask} before writing code.`,
    );
  }
  const control = (code: number) => String.fromCharCode(code);
  const requestBreak = new RegExp(
    `\\r\\n|[${control(0)}-${control(8)}\\n-${control(0x1f)}${control(0x7f)}-${control(0x9f)}${control(0x2028)}${control(0x2029)}]`,
  );
  if (args) {
    const quoted =
      command === "managed-agents-onboard" ||
      !/^[ -~]*$/.test(args) ||
      /[#`~<]|:\/\//.test(args);
    parts.push(
      quoted
        ? `## User Request\n\n> ${args.split(requestBreak).join("\n> ")}`
        : `## User Request\n\n${args}`,
    );
  }
  return parts.join("\n\n");
}

export const claudeApiSkill: BuiltinSkillSpec = {
  name: "claude-api",
  origin: "bundled",
  description:
    "Reference for the Claude API / Anthropic SDK \u2014 model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration.\nTRIGGER \u2014 read FIRST, before you answer, run a command or open a file (already started? read it now); don't skip because it \"looks like a one-liner\" \u2014 whenever: the prompt names Claude/Anthropic in any form (Claude, Anthropic, Fable, Opus, Sonnet, Haiku, `anthropic`, `@anthropic-ai`, `claude-*`, `us.anthropic.*`, `[1m]`); the user asks about an LLM (pricing/model choice/limits/caching) \u2014 never answer from memory; OR the task is LLM-shaped with provider unstated (agent/MCP/tool-definition/multi-agent/RAG/LLM-judge/computer-use; generate/summarize/extract/classify/rewrite/converse over NL; debugging refusals/cutoffs/streaming/tool-calls/tokens).\nSKIP only when another provider is being worked on (overrides all triggers): OpenAI/GPT/Gemini/Llama/Mistral/Cohere/Ollama named in the query; OR `grep -rE 'openai|langchain_openai|google.generativeai|genai|mistralai|cohere|ollama'` over the project hits (run this grep FIRST if no provider named \u2014 don't Read the file; if nothing hits, load this skill).",
  allowedTools: ["WebFetch(domain:platform.claude.com)"],
  disallowedTools: ["Agent(web-fetch)"],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: (context) =>
    !truthy(context.env.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL),
  files: () => CLAUDE_API_SKILL_FILES,
  prompt: (context) =>
    render(context.args, context.cwd, context.skillDir !== undefined),
  unported: [
    "H() ant-command trust check: tau has no ant CLI, so the prompt always says the security comparison is unavailable",
    "retiring-models scan (its flag defaults off) and the treatment prompt U()",
    "managed-agents-onboard quickstart and URL section, and the Onboarding Source tier paragraph",
    "the exact prompt-audit preamble that skips request quoting",
  ],
};
