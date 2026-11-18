import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  loadLaunchConfiguration,
  resolveGlobalConfigPath,
} from "../../src/launch-configuration.js";
import { parseOptions } from "../../src/options.js";

async function scratch() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-launch-edges-")),
  );
  const user = join(root, "user"),
    cwd = join(root, "work"),
    managed = join(root, "managed");
  for (const directory of [user, cwd, managed]) await mkdir(directory);
  onTestFinished(async () => {
    // A test may leave the user directory unlistable.
    await chmod(user, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    user,
    cwd,
    managed,
    normal: join(root, ".claude.json"),
    legacy: join(user, ".config.json"),
  };
}

test("a legacy .config.json that is not a regular file is ignored", async () => {
  const { user, normal, legacy } = await scratch();
  await mkdir(legacy);
  assert.equal(await resolveGlobalConfigPath(user, normal), normal);
});

test("a nonempty legacy config wins over a missing, empty or non-file ordinary config", async () => {
  const { user, normal, legacy } = await scratch();
  await writeFile(legacy, "{}");
  assert.equal(await resolveGlobalConfigPath(user, normal), legacy);
  await writeFile(normal, "");
  assert.equal(await resolveGlobalConfigPath(user, normal), legacy);
  await rm(normal);
  await mkdir(normal);
  assert.equal(await resolveGlobalConfigPath(user, normal), legacy);
});

test("an unreadable ordinary config path falls back to the legacy config", async () => {
  const { root, user, legacy } = await scratch();
  // A path below a regular file fails with ENOTDIR rather than ENOENT.
  const blocked = join(root, "file", ".claude.json");
  await writeFile(join(root, "file"), "");
  await writeFile(legacy, "");
  assert.equal(await resolveGlobalConfigPath(user, blocked), legacy);
  await writeFile(legacy, "{}");
  assert.equal(await resolveGlobalConfigPath(user, blocked), legacy);
});

test("an empty legacy config wins over a read-only empty ordinary config only on Linux", async () => {
  const { user, normal, legacy } = await scratch();
  await writeFile(legacy, "");
  await writeFile(normal, "");
  await chmod(normal, 0o444);
  assert.equal(await resolveGlobalConfigPath(user, normal, "linux"), legacy);
  assert.equal(await resolveGlobalConfigPath(user, normal, "darwin"), normal);
});

test("a legacy config whose directory cannot be listed is still adopted", async () => {
  const { user, normal, legacy } = await scratch();
  await writeFile(legacy, "{}");
  await writeFile(normal, "{}");
  await chmod(user, 0o100);
  assert.equal(await resolveGlobalConfigPath(user, normal), legacy);
});

test("a legacy config is matched by exact name, not by a case-folded alias", async () => {
  const { user, normal } = await scratch();
  await writeFile(join(user, ".Config.json"), "{}");
  await writeFile(normal, "{}");
  assert.equal(await resolveGlobalConfigPath(user, normal), normal);
});

test("launch defaults the user directory to ~/.claude and the managed root to the platform directory", async () => {
  const { root, cwd } = await scratch();
  for (const [platform, managedRoot] of [
    ["darwin", "/Library/Application Support/ClaudeCode"],
    ["linux", "/etc/claude-code"],
  ] as const) {
    const launch = await loadLaunchConfiguration(parseOptions([]), {
      cwd,
      env: {},
      homeDirectory: root,
      platform,
      nonInteractive: true,
      signal: new AbortController().signal,
    });
    assert.equal(launch.userConfigDir, join(root, ".claude"));
    assert.equal(launch.globalConfigPath, join(root, ".claude.json"));
    assert.equal(launch.managedRoot, managedRoot);
  }
});

test("launch rejects a relative managed root", async () => {
  const { root, cwd } = await scratch();
  await assert.rejects(
    loadLaunchConfiguration(parseOptions([]), {
      cwd,
      env: { TAU_MANAGED_ROOT: "managed" },
      homeDirectory: root,
    }),
    /TAU_MANAGED_ROOT must be an absolute directory/,
  );
});

test("--settings loads a file path and refuses one that cannot be loaded", async () => {
  const { root, user, cwd, managed } = await scratch();
  const env = { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed };
  const file = join(root, "flag.json");
  await writeFile(file, JSON.stringify({ model: "from-file" }));
  const run = (settings: string) =>
    loadLaunchConfiguration(
      { ...parseOptions([]), settings },
      { cwd, env, homeDirectory: root, nonInteractive: true },
    );
  assert.equal((await run(file)).model, "from-file");
  await assert.rejects(
    run(join(root, "missing.json")),
    /Cannot load --settings/,
  );
  await writeFile(file, "[1]");
  await assert.rejects(run(file), /Cannot load --settings/);
});

test("settings supply the fallback model as a string or a string list, and the default permission mode", async () => {
  const { root, user, cwd, managed } = await scratch();
  const env = { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed };
  const run = (settings: Record<string, unknown>, flags: string[] = []) =>
    loadLaunchConfiguration(
      { ...parseOptions(flags), settings: JSON.stringify(settings) },
      { cwd, env, homeDirectory: root, nonInteractive: true },
    );
  assert.equal((await run({ fallbackModel: "haiku" })).fallbackModel, "haiku");
  assert.equal(
    (await run({ fallbackModel: ["sonnet", "haiku"] })).fallbackModel,
    "sonnet,haiku",
  );
  assert.equal(
    (await run({ fallbackModel: ["sonnet", 3] })).fallbackModel,
    undefined,
  );
  assert.equal(
    (await run({ permissions: { defaultMode: "plan" } })).mode,
    "plan",
  );
  assert.equal(
    (await run({ permissions: { defaultMode: "dontAsk" } })).mode,
    "default",
  );
  assert.equal(
    (
      await run({ permissions: { defaultMode: "plan" } }, [
        "--permission-mode",
        "acceptEdits",
      ])
    ).mode,
    "acceptEdits",
  );
});
