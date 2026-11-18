// INV-03: a cloned repository's .claude/settings.json and
// .claude/settings.local.json cannot start tau in bypassPermissions. User,
// managed policy, --settings and CLI flags still can, and repository files
// still choose the non-dangerous modes.
import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLaunchConfiguration } from "../../src/launch-configuration.js";
import { parseOptions } from "../../src/options.js";

type Mode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
const settings = (defaultMode: Mode) =>
  JSON.stringify({ permissions: { defaultMode } });

async function launchMode(
  files: { user?: Mode; project?: Mode; local?: Mode; policy?: Mode },
  args: string[] = [],
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-repo-default-mode-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"),
    user = join(root, "user"),
    managed = join(root, "managed");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await mkdir(user);
  await mkdir(managed);
  if (files.user)
    await writeFile(join(user, "settings.json"), settings(files.user));
  if (files.project)
    await writeFile(
      join(cwd, ".claude/settings.json"),
      settings(files.project),
    );
  if (files.local)
    await writeFile(
      join(cwd, ".claude/settings.local.json"),
      settings(files.local),
    );
  if (files.policy)
    await writeFile(
      join(managed, "managed-settings.json"),
      settings(files.policy),
    );
  const launch = await loadLaunchConfiguration(parseOptions(["-p", ...args]), {
    cwd,
    env: { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed },
    homeDirectory: root,
    nonInteractive: true,
  });
  return launch.mode;
}

test("INV-03 project settings cannot grant bypassPermissions", async () => {
  assert.equal(await launchMode({ project: "bypassPermissions" }), "default");
});

test("INV-03 local settings cannot grant bypassPermissions", async () => {
  assert.equal(await launchMode({ local: "bypassPermissions" }), "default");
});

test("INV-03 user settings still grant bypassPermissions", async () => {
  assert.equal(
    await launchMode({ user: "bypassPermissions" }),
    "bypassPermissions",
  );
});

test("INV-03 managed policy still grants bypassPermissions", async () => {
  assert.equal(
    await launchMode({ policy: "bypassPermissions" }),
    "bypassPermissions",
  );
});

test("INV-03 --settings still grants bypassPermissions", async () => {
  assert.equal(
    await launchMode({}, ["--settings", settings("bypassPermissions")]),
    "bypassPermissions",
  );
});

test("INV-03 --permission-mode and --dangerously-skip-permissions still grant bypassPermissions", async () => {
  assert.equal(
    await launchMode({ project: "plan" }, [
      "--permission-mode",
      "bypassPermissions",
    ]),
    "bypassPermissions",
  );
  assert.equal(
    await launchMode({ local: "acceptEdits" }, [
      "--dangerously-skip-permissions",
    ]),
    "bypassPermissions",
  );
});

test("INV-03 repository settings still choose acceptEdits and plan", async () => {
  assert.equal(await launchMode({ project: "acceptEdits" }), "acceptEdits");
  assert.equal(await launchMode({ local: "plan" }), "plan");
  assert.equal(
    await launchMode({ user: "bypassPermissions", local: "plan" }),
    "plan",
  );
});

test("INV-03 an ignored repository bypass falls back to default, not to a lower-precedence mode", async () => {
  assert.equal(
    await launchMode({ user: "acceptEdits", project: "bypassPermissions" }),
    "default",
  );
});

test("INV-03 a repository bypass that a trusted source also grants still applies", async () => {
  assert.equal(
    await launchMode({ user: "bypassPermissions", local: "bypassPermissions" }),
    "bypassPermissions",
  );
});
