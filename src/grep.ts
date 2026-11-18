import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const noNul = z
  .string()
  .refine((value) => !value.includes("\0"), "NUL bytes are not supported");
export const grepInputSchema = z.strictObject({
  pattern: noNul.min(1).max(4096),
  path: noNul.max(4096).default("."),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .default("files_with_matches"),
  "-i": z.boolean().default(false),
  "-n": z.boolean().default(true),
  head_limit: z.number().int().min(0).max(10000).default(250),
  offset: z.number().int().min(0).max(10000).default(0),
});
export type GrepInput = z.infer<typeof grepInputSchema>;

export async function findRipgrep(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const executable = await realpath(path.join(directory, "rg"));
      await access(executable, constants.X_OK);
      if ((await stat(executable)).isFile()) return executable;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        throw error;
    }
  }
  throw new Error(
    "Grep requires standalone ripgrep (rg) in an absolute PATH directory; no literal-search fallback is used",
  );
}

export function searchText(options: {
  executable: string;
  input: GrepInput;
  text: string;
  signal: AbortSignal;
  timeout: number;
}): Promise<{ matched: boolean; output: string }> {
  const { input, signal } = options;
  signal.throwIfAborted();
  if (options.timeout <= 0) return Promise.reject(new Error("Grep timed out"));
  const args = [
    "--no-config",
    "--color=never",
    "--no-heading",
    "--no-filename",
    "--engine=default",
    "--text",
    input["-i"] ? "--ignore-case" : "--case-sensitive",
    `--regexp=${input.pattern}`,
  ];
  switch (input.output_mode) {
    case "content":
      args.push(input["-n"] ? "--line-number" : "--no-line-number");
      break;
    case "files_with_matches":
      args.push("--quiet");
      break;
    case "count":
      args.push("--count");
      break;
    default: {
      const exhaustive: never = input.output_mode;
      throw new Error(`Unknown Grep mode: ${exhaustive}`);
    }
  }
  args.push("--", "-");
  return new Promise((resolve, reject) => {
    // Only bounded, already-opened workspace contents reach rg, never filesystem paths or shell code.
    const child = spawn(options.executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { LC_ALL: "C" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(error);
    };
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        fail(new Error("Grep backend output limit exceeded"));
        return;
      }
      chunks.push(chunk);
    };
    const abort = () => fail(new Error("Grep aborted"));
    const timer = setTimeout(
      () => fail(new Error("Grep timed out")),
      options.timeout,
    );
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", (error) => {
      if (!("code" in error) || error.code !== "EPIPE") fail(error);
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (done) return;
      if (code !== 0 && code !== 1) {
        fail(
          new Error(
            `Grep backend failed (exit ${code}): ${Buffer.concat(stderr).toString().slice(0, 4096)}`,
          ),
        );
        return;
      }
      done = true;
      cleanup();
      resolve({
        matched: code === 0,
        output: Buffer.concat(stdout).toString(),
      });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else child.stdin.end(options.text);
  });
}
