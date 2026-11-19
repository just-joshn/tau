import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { z } from "zod";
import {
  bashDescription,
  bashInputSchema,
  bashPromptFacts,
  bashTimeouts,
  type BashPromptFacts,
} from "../../src/bash-description.js";

const original = z
  .object({
    tool: z.object({ description: z.string(), input_schema: z.unknown() }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        path.join(import.meta.dir, "../fixtures/bash/original-bash-tool.json"),
        "utf8",
      ),
    ),
  ).tool;

// The original's isolation facts: print mode, zsh probe miss, embedded find/grep.
const originalFacts = (): BashPromptFacts => ({
  ...bashPromptFacts({}, undefined),
  embeddedSearch: true,
});

test("the original's facts render its Bash description and schema byte for byte", () => {
  assert.equal(bashDescription(originalFacts()), original.description);
  assert.equal(
    JSON.stringify(bashInputSchema(originalFacts())),
    JSON.stringify(original.input_schema),
  );
});

test("tau's facts name Glob and Grep instead of the embedded find and grep", () => {
  const text = bashDescription(bashPromptFacts({}, undefined));
  assert.match(
    text,
    /Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands/,
  );
  assert.match(
    text,
    / - File search: Use Glob \(NOT find or ls\)\n - Content search: Use Grep \(NOT grep or rg\)\n/,
  );
  assert.doesNotMatch(text, /When running `find`/);
});

test("disabled background tasks drop run_in_background and the polling advice", () => {
  const facts = bashPromptFacts(
    { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    undefined,
  );
  assert.equal("run_in_background" in bashInputSchema(facts).properties, false);
  const text = bashDescription(facts);
  assert.doesNotMatch(text, /You can use the `run_in_background` parameter/);
  assert.doesNotMatch(text, /Long leading `sleep` commands are blocked/);
  assert.match(
    text,
    / {2}- Use the Monitor tool to stream events from a background process \(each stdout line is a notification\)\.\n {2}- Do not retry/,
  );
  assert.match(text, /If you must sleep, keep the duration short/);
});

test("interactive sessions describe background commands without a deadline", () => {
  const facts = bashPromptFacts({}, undefined, {
    nonInteractive: false,
    singleShot: false,
  });
  assert.equal(
    bashInputSchema(facts).properties.run_in_background?.description,
    "Set to true to run this command in the background.",
  );
  assert.match(
    bashDescription(facts),
    /when using this parameter\.\n - For git commands:/,
  );
});

test("gates for cwd, git instructions, task tool and macOS bash 3.2", () => {
  const maintain = bashDescription(
    bashPromptFacts(
      { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "true" },
      undefined,
    ),
  );
  assert.match(
    maintain,
    /\nEvery call starts in the start folder: a `cd` does not carry over\. Shell state/,
  );
  const noGit = bashDescription(
    bashPromptFacts({ CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" }, undefined),
  );
  assert.doesNotMatch(noGit, /# Committing changes with git/);
  assert.ok(
    noGit.endsWith("Do not chain shorter sleeps to work around the block.\n"),
  );
  const todo = bashDescription(
    bashPromptFacts({ CLAUDE_CODE_ENABLE_TASKS: "false" }, undefined),
  );
  assert.match(todo, /NEVER use the TodoWrite or Agent tools/);
  const heredoc: BashPromptFacts = {
    ...bashPromptFacts({}, "/bin/bash"),
    platform: "darwin",
  };
  const text = bashDescription(heredoc);
  assert.match(
    text,
    /^Executes a given bash command and returns its output\.\n\nThis tool runs macOS's \/bin\/bash \(version 3\.2\)[^\n]*\(`git commit -F - <<'EOF'`, `gh pr create --body-file - <<'EOF'`\)/,
  );
  assert.match(
    text,
    /<example>\ngit commit -F - <<'EOF'\nCommit message here\.\nEOF\n<\/example>/,
  );
  assert.match(
    text,
    /gh pr create --title "the pr title" --body-file - <<'EOF'\n/,
  );
  const heredocNoGit = bashDescription({ ...heredoc, gitInstructions: false });
  assert.match(heredocNoGit, /on stdin with `<<'EOF'` and end the command/);
  assert.match(heredocNoGit, /a skill refuses that, use/);
});

test("timeouts follow BASH_DEFAULT_TIMEOUT_MS and BASH_MAX_TIMEOUT_MS", () => {
  assert.deepEqual(bashTimeouts({}), {
    defaultMs: 120000,
    maxMs: 600000,
    backgroundDefaultMs: 600000,
    backgroundMaxMs: 7200000,
  });
  assert.deepEqual(
    bashTimeouts(
      { BASH_DEFAULT_TIMEOUT_MS: "900000", BASH_MAX_TIMEOUT_MS: "1,000" },
      false,
    ),
    {
      defaultMs: 900000,
      maxMs: 900000,
      backgroundDefaultMs: 1800000,
      backgroundMaxMs: 7200000,
    },
  );
  assert.equal(
    bashTimeouts({ BASH_DEFAULT_TIMEOUT_MS: "-5" }).defaultMs,
    120000,
  );
  const facts = bashPromptFacts(
    { BASH_MAX_TIMEOUT_MS: "9000000", BASH_DEFAULT_TIMEOUT_MS: "60000" },
    undefined,
  );
  const text = bashDescription(facts);
  assert.match(
    text,
    /up to 9000000ms \/ 150 minutes for a foreground command\)\. By default, your command will timeout after 60000ms \(1 minutes\)/,
  );
  assert.match(text, /max 9000000ms \/ 3 hours\)/);
  const short = bashDescription({
    ...facts,
    timeouts: { ...facts.timeouts, backgroundMaxMs: 3600000 },
  });
  assert.match(short, /max 3600000ms \/ 60 minutes\)/);
});
