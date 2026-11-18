import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider, turn } from "../helpers/mock-provider.js";

const oracle = z
  .object({
    agentListing: z.string(),
    skillListing: z.string(),
    init: z.object({
      agents: z.array(z.string()),
      skills: z.array(z.string()),
      plugins: z.array(
        z.object({ name: z.string(), path: z.string(), source: z.string() }),
      ),
      slash_commands: z.array(z.string()),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../fixtures/builtin-catalog/oracle-first-request.json",
        ),
        "utf8",
      ),
    ),
  );
const requestBody = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.array(
        z.looseObject({
          type: z.string(),
          text: z.string().optional(),
          content: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
const initMessage = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  agents: z.array(z.string()),
  skills: z.array(z.string()),
  plugins: z.array(z.looseObject({ name: z.string() })),
  slash_commands: z.array(z.string()),
});

/** A `.git` marker stops the skill directory walk at the workspace, away from any ancestor skills. */
const isolatedWorkspace = { ".git/HEAD": "ref: refs/heads/main\n" };

async function print(
  script: Parameters<typeof startMockProvider>[0],
  prompt: string,
) {
  const provider = await startMockProvider(script);
  const run = await runCli({
    args: [
      "--print",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    files: isolatedWorkspace,
    provider,
  });
  expect(run.exitCode).toBe(0);
  return {
    run,
    bodies: provider.requests.map((request) =>
      requestBody.parse(request.body),
    ),
  };
}

test("the first request lists the original's built-in agents and skills verbatim", async () => {
  const { run, bodies } = await print(
    [turn({ type: "text", text: "done" })],
    "hello",
  );
  const texts = bodies[0]?.messages[0]?.content.map((block) => block.text);
  expect(texts).toContain(oracle.agentListing);
  expect(texts).toContain(oracle.skillListing);
  expect(bodies[0]?.tools.map((tool) => tool.name)).toContain("Skill");

  const init = initMessage.parse(JSON.parse(run.stdout.split("\n")[0] ?? ""));
  expect(init.agents).toEqual(oracle.init.agents);
  expect(init.skills).toEqual(oracle.init.skills);
  expect(init.plugins).toEqual(oracle.init.plugins);
  // Tau lists only the commands it implements, in the original's order.
  expect(init.slash_commands).toEqual(
    oracle.init.slash_commands.filter((name) =>
      [...oracle.init.skills, "init", "security-review"].includes(name),
    ),
  );
});

test("the Skill tool loads a built-in skill's body and writes its files", async () => {
  const { bodies } = await print(
    [
      turn({
        type: "tool_use",
        id: "call-1",
        name: "Skill",
        input: { skill: "dataviz", args: "a bar chart of sales" },
      }),
      turn({ type: "text", text: "done" }),
    ],
    "chart this",
  );
  const blocks = bodies[1]?.messages.flatMap((message) => message.content);
  expect(blocks?.find((block) => block.type === "tool_result")?.content).toBe(
    "Launching skill: dataviz",
  );
  const body = blocks?.find((block) =>
    block.text?.startsWith("Base directory for this skill: "),
  )?.text;
  const directory = /^Base directory for this skill: (.+)\n/.exec(
    body ?? "",
  )?.[1];
  expect(directory?.endsWith("/dataviz")).toBe(true);
  expect(body?.endsWith("## User Request\n\na bar chart of sales")).toBe(true);
  // dataviz ships references/palette.md (chunk-yvvw9mhr.js SKILL_FILES).
  expect(
    readFileSync(join(directory ?? "", "references/palette.md"), "utf8")
      .length,
  ).toBeGreaterThan(0);
});
