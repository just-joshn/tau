import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "bun:test";
import {
  describedShell,
  NoShellError,
  selectShell,
} from "../../src/bash-shell.js";

const PATH = "/usr/bin:/bin";

test("CLAUDE_CODE_SHELL, then SHELL, then zsh before bash pick the shell", () => {
  assert.equal(
    selectShell({ PATH, CLAUDE_CODE_SHELL: "/bin/bash", SHELL: "/bin/zsh" }),
    "/bin/bash",
  );
  assert.equal(selectShell({ PATH, SHELL: "/bin/bash" }), "/bin/bash");
  // A shell that is neither bash nor zsh is never a candidate.
  const fallback = selectShell({ PATH, SHELL: "/bin/sh" });
  assert.ok(fallback.endsWith("zsh") || fallback.endsWith("bash"));
  assert.equal(
    selectShell({
      PATH,
      CLAUDE_CODE_SHELL: "/missing/zsh",
      SHELL: "/bin/bash",
    }),
    "/bin/bash",
  );
});

test("the description probe resolves candidates through PATH", () => {
  assert.equal(describedShell({ PATH, SHELL: "/bin/bash" }), "/bin/bash");
  const zsh = describedShell({ PATH: "/bin", SHELL: "/bin/sh" });
  assert.equal(zsh, existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
});

test("the missing-shell error carries the original's message", () => {
  assert.match(
    new NoShellError().message,
    /^No suitable shell found\. Claude CLI requires a Posix shell environment\./,
  );
});
