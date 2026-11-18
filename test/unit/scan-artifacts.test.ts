import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, onTestFinished, test } from "bun:test";
import { redactSecrets, scanArtifacts } from "../../scripts/scan-artifacts.js";

// Built at runtime so no key-shaped literal lives in the repository.
const fakeKey = ["sk", "ant", "api03", "x".repeat(24)].join("-");
const sentinel = "TAU_SENTINEL_artifact_scan";

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-scan-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

test("reports each sentinel and key with file, line and a masked value", async () => {
  const root = await workspace({
    "coverage/lcov.info": "SF:src/a.ts\nDA:1,1\n",
    "test-results/nested/junit.xml": `<ok/>\n<failure>${sentinel}</failure>\nkey=${fakeKey}\n`,
  });
  const findings = scanArtifacts([
    join(root, "coverage"),
    join(root, "test-results"),
  ]);
  expect(findings).toEqual([
    {
      file: join(root, "test-results/nested/junit.xml"),
      line: 2,
      kind: "sentinel",
      masked: "TAU_SENTINEL_***",
    },
    {
      file: join(root, "test-results/nested/junit.xml"),
      line: 3,
      kind: "anthropic-key",
      masked: "sk-ant-***",
    },
  ]);
  expect(JSON.stringify(findings)).not.toContain("artifact_scan");
  expect(JSON.stringify(findings)).not.toContain("x".repeat(24));
});

test("ignores short sk-ant- prefixes and missing directories", async () => {
  const root = await workspace({
    "out/notes.txt": "see sk-ant-short and docs\n",
  });
  expect(scanArtifacts([join(root, "out"), join(root, "absent")])).toEqual([]);
});

test("redactSecrets masks every secret-shaped substring", () => {
  expect(redactSecrets(`a ${sentinel} b ${fakeKey} c`)).toBe(
    "a TAU_SENTINEL_*** b sk-ant-*** c",
  );
});

test("CLI exits 1 with masked findings and 0 when clean", async () => {
  const root = await workspace({
    "dirty/trace.jsonl": `{"k":"${fakeKey}"}\n`,
    "clean/a.txt": "fine\n",
  });
  const script = resolve("scripts/scan-artifacts.ts");
  const dirty = Bun.spawnSync([
    process.execPath,
    script,
    join(root, "dirty"),
    join(root, "absent"),
  ]);
  expect(dirty.exitCode).toBe(1);
  expect(dirty.stderr.toString()).toContain(
    "trace.jsonl:1: anthropic-key sk-ant-***",
  );
  expect(dirty.stderr.toString() + dirty.stdout.toString()).not.toContain(
    "x".repeat(24),
  );
  const clean = Bun.spawnSync([process.execPath, script, join(root, "clean")]);
  expect(clean.exitCode).toBe(0);
});
