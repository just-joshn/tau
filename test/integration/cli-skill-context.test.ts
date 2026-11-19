import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { runCli } from "../helpers/cli-harness.js";
import {
  startMockProvider,
  type MockProvider,
  type ScriptedResponse,
} from "../helpers/mock-provider.js";

setDefaultTimeout(30_000);

const said = (text: string): ScriptedResponse => ({
  kind: "turn",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});
const call = (
  name: string,
  input: Record<string, unknown>,
  id: string,
): ScriptedResponse => ({
  kind: "turn",
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

// Renders the effort level of whoever loads it.
const SHOW = {
  "../config/skills/show/SKILL.md":
    "---\ndescription: Show effort\n---\nEFFORT_IS_${CLAUDE_EFFORT}_END",
};
const sent = (provider: MockProvider, index: number) =>
  JSON.stringify(provider.requests[index]?.body);
const rendered = (provider: MockProvider, index: number) =>
  [...sent(provider, index).matchAll(/EFFORT_IS_([a-z]*)_END/g)].map(
    (match) => match[1],
  );

describe("effort seen by skills", () => {
  test("a user-invoked skill's effort is what later skills render", async () => {
    const files = {
      ...SHOW,
      "../config/skills/fast/SKILL.md":
        "---\ndescription: Go fast\neffort: low\n---\nFAST_BODY",
    };
    const fast = await startMockProvider([
      call("Skill", { skill: "show" }, "s1"),
      said("done"),
    ]);
    const run = await runCli({ provider: fast, files, args: ["-p", "/fast"] });
    expect(run.exitCode).toBe(0);
    expect(rendered(fast, 1)).toEqual(["low"]);

    const plain = await startMockProvider([
      call("Skill", { skill: "show" }, "s1"),
      said("done"),
    ]);
    const control = await runCli({
      provider: plain,
      files,
      args: ["-p", "plain"],
    });
    expect(control.exitCode).toBe(0);
    expect(rendered(plain, 1)).toEqual(["medium"]);
  });

  const child =
    (agentFrontmatter: string, extraEnv: Record<string, string> = {}) =>
    async (skills = "") => {
      const provider = await startMockProvider([
        call(
          "Agent",
          {
            description: "Show effort",
            prompt: "show effort",
            subagent_type: "helper",
            run_in_background: false,
          },
          "agent-1",
        ),
        call("Skill", { skill: "show" }, "s1"),
        said("child done"),
        said("parent done"),
      ]);
      const run = await runCli({
        provider,
        env: {
          CLAUDE_CODE_FORK_SUBAGENT: "0",
          CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
          ...extraEnv,
        },
        files: {
          ...SHOW,
          "../config/agents/helper.md": `---\nname: helper\ndescription: Helper\ntools: Skill, Read\n${skills}${agentFrontmatter}---\nHELPER_SYSTEM`,
        },
        args: ["-p", "delegate", "--tools", "Agent,Skill,Read"],
      });
      expect(run.exitCode).toBe(0);
      return provider;
    };

  test("a subagent's skill renders the agent definition's effort", async () => {
    const provider = await child("effort: low\n")();
    expect(rendered(provider, 2)).toEqual(["low"]);
  });

  test("a subagent's skill renders CLAUDE_CODE_EFFORT_LEVEL", async () => {
    const provider = await child("", { CLAUDE_CODE_EFFORT_LEVEL: "high" })();
    expect(rendered(provider, 2)).toEqual(["high"]);
  });

  test("a subagent on a model without effort support cannot load an effort placeholder skill", async () => {
    const provider = await child("model: acme-local-model\n")();
    expect(sent(provider, 2)).toContain('"model":"acme-local-model"');
    expect(sent(provider, 2)).toContain(
      "Skill effort placeholder requires the caller's resolved effortLevel",
    );
    expect(rendered(provider, 2)).toEqual([]);
  });

  test.failing(
    "KNOWN-GAP a subagent's preloaded skill renders the subagent's effort, as its Skill tool does",
    async () => {
      const provider = await child("effort: low\n")("skills: show\n");
      // The child's first request carries only the preload; its Skill call renders "low".
      expect(rendered(provider, 1)).toEqual(["low"]);
    },
  );
});

describe("conditional skills", () => {
  const files = {
    "src/a.txt": "x",
    ".claude/skills/cond/SKILL.md":
      "---\ndescription: Conditional workflow\npaths: ['src/**']\n---\nCOND_BODY",
  };
  const script = () => [
    call("Read", { file_path: "src/a.txt" }, "r1"),
    said("done"),
  ];

  test("reading a matching file offers the skill on the next request", async () => {
    const provider = await startMockProvider(script());
    const run = await runCli({ provider, files, args: ["-p", "go"] });
    expect(run.exitCode).toBe(0);
    expect(sent(provider, 0)).not.toContain("Conditional workflow");
    expect(sent(provider, 1)).toContain("Conditional workflow");
  });

  test("CLAUDE_CODE_SIMPLE stops reads from activating it", async () => {
    const provider = await startMockProvider(script());
    const run = await runCli({
      provider,
      env: { CLAUDE_CODE_SIMPLE: "1" },
      files,
      args: ["-p", "go"],
    });
    expect(run.exitCode).toBe(0);
    expect(sent(provider, 1)).not.toContain("Conditional workflow");
  });
});
