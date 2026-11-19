/* Independent TaskCompleted fixture, owned logs only. */
const fs = require("node:fs");
const [mode, logPath] = process.argv.slice(2);
if (mode === "ready") {
  fs.appendFileSync(
    logPath,
    JSON.stringify({ event: "ready", pid: process.pid }) + "\n",
  );
  process.stdout.write("owned-task-hook-ready");
  process.exit(0);
}
const log = (row) =>
  fs.appendFileSync(
    logPath,
    JSON.stringify({ pid: process.pid, ...row }) + "\n",
  );
log({ event: "start" });
process.on("exit", (code) => log({ event: "exit", code }));
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
  if (data.length > 1024 * 1024) process.exit(3);
});
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(data);
  } catch {
    process.exitCode = 3;
    return;
  }
  const invocation =
    fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((row) => row.event === "input").length + 1;
  log({ event: "input", invocation, input });
  if (invocation === 1) {
    process.stderr.write("OWNED_TASK_COMPLETION_BLOCK");
    process.exitCode = 2;
    return;
  }
  if (invocation > 2) {
    process.stderr.write("OWNED_TASK_HOOK_BOUND");
    process.exitCode = 3;
    return;
  }
  process.stdout.write("{}\n");
});
