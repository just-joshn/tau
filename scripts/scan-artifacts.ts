import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const secretPatterns = [
  { kind: "sentinel", pattern: /TAU_SENTINEL_[A-Za-z0-9_-]*/g },
  { kind: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
] as const;

export type Finding = {
  file: string;
  line: number;
  kind: (typeof secretPatterns)[number]["kind"];
  masked: string;
};

function mask(value: string): string {
  return `${value.slice(0, value.startsWith("sk-ant-") ? 7 : 13)}***`;
}

export function redactSecrets(text: string): string {
  return secretPatterns.reduce(
    (current, { pattern }) => current.replace(pattern, mask),
    text,
  );
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

export function scanArtifacts(dirs: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of dirs
    .filter((dir) => existsSync(dir))
    .flatMap(filesUnder)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, index) => {
        for (const { kind, pattern } of secretPatterns)
          for (const match of text.matchAll(pattern))
            findings.push({
              file,
              line: index + 1,
              kind,
              masked: mask(match[0]),
            });
      });
  }
  return findings;
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("usage: bun scripts/scan-artifacts.ts <dir>...");
    process.exit(2);
  }
  const findings = scanArtifacts(dirs);
  for (const { file, line, kind, masked } of findings)
    console.error(`${file}:${line}: ${kind} ${masked}`);
  const scanned = dirs.filter((dir) => existsSync(dir));
  console.log(
    `scan-artifacts: ${findings.length} finding(s) in ${scanned.join(", ") || "no existing directories"}`,
  );
  if (findings.length > 0) process.exit(1);
}
