import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { builtinSkillDefinitions } from "../../src/builtin-skills/index.js";

const gate = { env: {}, interactive: false, platform: "darwin" as const };

function definitions(cwd: string) {
  const root = mkdtempSync(join(tmpdir(), "tau-claude-api-"));
  return builtinSkillDefinitions({ gate, cwd, root }).find(
    (definition) => definition.info.name === "claude-api",
  );
}

test("claude-api renders the ordinary prompt and writes its reference files", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tau-claude-api-work-"));
  const skill = definitions(cwd);
  const render = skill?.render;
  if (render === undefined) throw new Error("claude-api was not registered");
  expect(skill?.info.allowedTools).toEqual([
    "WebFetch(domain:platform.claude.com)",
  ]);
  expect(skill?.info.disallowedTools).toEqual(["Agent(web-fetch)"]);
  const text = await render("how do streams work", {
    sessionId: "session",
  });
  // chunk-pcxjjtda.js ne(), with files extracted and no ant checker.
  expect(text.startsWith("Base directory for this skill: ")).toBe(true);
  expect(text).toContain(
    "Choose the right surface based on your needs, detect the project language",
  );
  expect(text).toContain("claude-opus-5-5");
  expect(text).not.toContain("{{OPUS_ID}}");
  expect(text).toContain(
    "Claude Code cannot check the `ant` commands of `managed-agents-secure`",
  );
  expect(text).toContain("No project language was auto-detected.");
  expect(text.endsWith("## User Request\n\nhow do streams work")).toBe(true);
  const directory = /^Base directory for this skill: (.+)\n/.exec(text)?.[1];
  expect(
    readFileSync(join(directory ?? "", "shared/live-sources.md"), "utf8")
      .length,
  ).toBeGreaterThan(0);
});

test("claude-api inlines the readme of the first detected language", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tau-claude-api-ts-"));
  writeFileSync(join(cwd, "package.json"), "{}");
  writeFileSync(join(cwd, "app.py"), "");
  const render = definitions(cwd)?.render;
  if (render === undefined) throw new Error("claude-api was not registered");
  const text = await render("", { sessionId: "session" });
  // python's markers come before typescript's, and .py matches by suffix.
  expect(text).toContain("## Detected Language: python");
  expect(text).toContain('<doc path="python/claude-api/README.md">');
  expect(text).not.toContain("No project language was auto-detected.");
});

test("CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL withholds the skill", () => {
  const listed = builtinSkillDefinitions({
    gate: {
      env: { CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: "true" },
      interactive: false,
      platform: "darwin",
    },
    cwd: mkdtempSync(join(tmpdir(), "tau-claude-api-off-")),
    root: mkdtempSync(join(tmpdir(), "tau-claude-api-root-")),
  }).map((definition) => definition.info.name);
  expect(listed).not.toContain("claude-api");
  expect(listed[0]).toBe("deep-research");
});
