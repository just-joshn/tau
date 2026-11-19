import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  ensureSnapshot,
  shellQuote,
  usableSnapshot,
} from "../../src/shell-snapshot.js";

const SHELLS = ["/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell));

/** A private HOME with the given rc files and a config folder whose name needs quoting. */
async function home(rc: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "tau-snap-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(rc))
    await writeFile(path.join(root, name), text);
  const config = path.join(root, "it's config");
  await mkdir(config);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    CLAUDE_CONFIG_DIR: config,
  };
  return { root, env };
}

/** What buildExecCommand runs: source the snapshot, then the command. */
const runSourced = (shell: string, file: string, command: string) =>
  execFileSync(
    shell,
    [
      "-c",
      `source ${shellQuote(file)} 2>/dev/null || true && eval ${shellQuote(command)}`,
    ],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
  );

const RC = [
  "alias greet='echo hello from alias'",
  'shout() { echo "SHOUT:$1"; }',
  "export PATH=/rc/only:$PATH",
].join("\n");

for (const shell of SHELLS)
  test(`${shell}: rc aliases and functions survive into a sourced snapshot; PATH stays the CLI's`, async () => {
    const { env } = await home({ ".bashrc": RC, ".zshrc": RC });
    const file = await usableSnapshot(shell, env);
    assert.ok(file);
    assert.ok(file.includes("/shell-snapshots/snapshot-"));
    assert.equal(
      runSourced(shell, file, "greet; shout x; echo $PATH"),
      `hello from alias\nSHOUT:x\n${env.PATH}\n`,
    );
  });

test("concurrent first calls share one snapshot", async () => {
  const shell = SHELLS[0];
  assert.ok(shell);
  const { env } = await home();
  const [first, second] = await Promise.all([
    ensureSnapshot(shell, env),
    ensureSnapshot(shell, env),
  ]);
  assert.equal(first.kind, "ready");
  assert.deepEqual(second, first);
  assert.deepEqual(await ensureSnapshot(shell, env), first);
});

test("without an rc file the snapshot still loads", async () => {
  const shell = SHELLS[0];
  assert.ok(shell);
  const { env } = await home();
  const file = await usableSnapshot(shell, env);
  assert.ok(file);
  assert.equal(runSourced(shell, file, "echo ok"), "ok\n");
});

for (const [label, rc, timeoutMs] of [
  ["exits nonzero", "exit 3\n", undefined],
  ["exits before the snapshot is written", "exit 0\n", undefined],
  ["outlives the time limit", "sleep 5\n", 300],
] as const)
  test(`an rc file that ${label} fails the snapshot, so calls fall back to -l`, async () => {
    const shell = SHELLS[0];
    assert.ok(shell);
    const { env } = await home({ ".bashrc": rc, ".zshrc": rc });
    const settled = await ensureSnapshot(shell, env, timeoutMs);
    assert.equal(settled.kind, "failed");
    assert.equal(await usableSnapshot(shell, env), undefined);
  });

test("a snapshot file deleted after creation falls back per call", async () => {
  const shell = SHELLS[0];
  assert.ok(shell);
  const { env } = await home();
  const file = await usableSnapshot(shell, env);
  assert.ok(file);
  await rm(file);
  assert.equal(await usableSnapshot(shell, env), undefined);
});

test("shellQuote leaves safe words bare and single-quotes the rest", () => {
  assert.equal(shellQuote("/a/b-c_d.sh"), "/a/b-c_d.sh");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("it's here"), `'it'"'"'s here'`);
});

test("/bin/sh uses .profile and names the snapshot shellKind sh", async () => {
  if (!existsSync("/bin/sh")) return;
  // Profile content is only used during create. The dump itself does not re-export
  // it, and aliases are not portable on dash (Ubuntu /bin/sh).
  const { env } = await home({
    ".profile": "# tau-shell-snapshot-profile\n",
  });
  const file = await usableSnapshot("/bin/sh", env);
  assert.ok(file);
  assert.match(file, /snapshot-sh-/);
  assert.match(await readFile(file, "utf8"), /# Snapshot file/);
});

test("omitted PATH/HOME/CLAUDE_CONFIG_DIR with DONT_INHERIT_ENV still produce a usable snapshot", async () => {
  const shell = SHELLS[0];
  assert.ok(shell);
  const { env } = await home();
  // Omit PATH so `??` falls back; omit CLAUDE_CONFIG_DIR so it derives from HOME;
  // keep HOME under the temp tree so snapshots never touch the real home.
  const stripped: NodeJS.ProcessEnv = {
    HOME: env.HOME,
    CLAUDE_CODE_DONT_INHERIT_ENV: "1",
  };
  const withConfig = await usableSnapshot(shell, {
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_DONT_INHERIT_ENV: "1",
  });
  assert.ok(withConfig);
  const file = await usableSnapshot(shell, stripped);
  assert.ok(file);
  assert.equal(runSourced(shell, file, "echo ok"), "ok\n");
});

test("zsh without a .zshrc still writes a snapshot", async () => {
  if (!existsSync("/bin/zsh")) return;
  const { env } = await home();
  const file = await usableSnapshot("/bin/zsh", env);
  assert.ok(file);
  assert.match(file, /snapshot-zsh-/);
  assert.equal(runSourced("/bin/zsh", file, "echo ok"), "ok\n");
});
