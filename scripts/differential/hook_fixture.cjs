/* Independent disposable command-hook fixture; no application code imported. */
const fs = require("node:fs");
const [mode, logPath, scenario] = process.argv.slice(2);
if (mode === "ready") {
  fs.appendFileSync(
    logPath,
    JSON.stringify({ event: "ready", pid: process.pid }) + "\n",
  );
  process.stdout.write("owned-hook-fixture-ready");
  process.exit(0);
}
const log = (value) =>
  fs.appendFileSync(
    logPath,
    JSON.stringify({ pid: process.pid, ...value }) + "\n",
  );
log({ event: "start" });
process.on("exit", () => log({ event: "exit" }));
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
    log({ event: "invalid-stdin" });
    process.exitCode = 3;
    return;
  }
  log({ event: "input", input });
  const name = input.hook_event_name;
  if (name === "PreToolUse") {
    let permissionDecision = scenario === "deny" ? "deny" : "allow";
    const specific = {
      hookEventName: name,
      permissionDecision,
      permissionDecisionReason: "OWNED_HOOK_" + scenario.toUpperCase(),
    };
    if (scenario === "rewrite-allow" && input.tool_name === "Write")
      specific.updatedInput = {
        ...input.tool_input,
        content: "rewritten by owned hook\n",
      };
    if (scenario === "rewrite-path" && input.tool_name === "Write")
      specific.updatedInput = {
        file_path: "alternate/rewritten.txt",
        content: "rewritten path by owned hook\n",
      };
    if (scenario === "invalid-rewrite" && input.tool_name === "Write")
      specific.updatedInput = { file_path: "invalid-hook-target.txt" };
    specific.additionalContext = "OWNED_PRE_CONTEXT_" + input.tool_name;
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: specific }) + "\n",
    );
  } else if (name === "PostToolUse") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: name,
          additionalContext: "OWNED_POST_CONTEXT_" + input.tool_name,
        },
      }) + "\n",
    );
  } else if (name === "Stop") {
    const count = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (row) => row.event === "input" && row.input.hook_event_name === "Stop",
      ).length;
    process.stdout.write(
      JSON.stringify(
        count === 1
          ? { decision: "block", reason: "OWNED_STOP_CONTINUATION" }
          : {},
      ) + "\n",
    );
  } else if (name === "SessionStart") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: name,
          additionalContext:
            "OWNED_SESSION_" + String(input.source).toUpperCase(),
        },
      }) + "\n",
    );
  } else process.stdout.write("{}\n");
});
