/** Source admission predicates only: no command parsing, execution or permission grant. */
const runners = [
  "python",
  "python3",
  "python2",
  "node",
  "deno",
  "tsx",
  "ruby",
  "perl",
  "php",
  "lua",
  "npx",
  "bunx",
  "npm run",
  "yarn run",
  "pnpm run",
  "bun run",
  "bash",
  "sh",
  "ssh",
];
const bashRunners = [
  ...runners,
  "zsh",
  "fish",
  "eval",
  "exec",
  "env",
  "xargs",
  "sudo",
];
const wrappers = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "mksh",
  "dash",
  "ash",
  "hush",
  "rbash",
  "rsh",
  "busybox",
  "toybox",
  "wsl",
  "cmd",
  "powershell",
  "pwsh",
  "env",
  "xargs",
  "command",
  "builtin",
  "noglob",
  "nice",
  "stdbuf",
  "nohup",
  "timeout",
  "time",
  "watch",
  "ionice",
  "chrt",
  "setsid",
  "taskset",
  "strace",
  "ltrace",
  "script",
  "flock",
  "unshare",
  "nsenter",
  "sandbox-exec",
  "sudo",
  "doas",
  "pkexec",
  "su",
  "runuser",
]);
const subcommandRunners = new Set([
  "curl",
  "wget",
  "kubectl",
  "aws",
  "gcloud",
  "gsutil",
]);
const dangerousSubcommands: Readonly<
  Record<string, ReadonlySet<string> | "all">
> = {
  kubectl: new Set([
    "exec",
    "apply",
    "create",
    "delete",
    "run",
    "cp",
    "port-forward",
    "proxy",
    "patch",
    "edit",
    "replace",
    "attach",
    "debug",
    "scale",
    "rollout",
    "drain",
    "cordon",
    "taint",
  ]),
};
const whitespaceToken =
  /\s*((?:\\.|'[^']*'|"(?:\\.|[^"\\])*"|[^\s\\'"])+)(?=\s)/gsy;
const environmentOrOption =
  /^(?:\w+\+?=|-|\/+\w$|\d[\d.]*[smhd]?$|[^a-z0-9]*$)|[^\w .+@%,:~/-]/i;
const commandStringFlag = /^(?:-\w*c|\/c)$/i;
function baseCommand(value: string): string {
  return value
    .replace(/^.*[\\/]/s, "")
    .toLowerCase()
    .replace(/^(.*?[^\d.])?[\d.]*(?:\.exe)?$/s, "$1");
}
/** ce: literal-prefix analysis before the first unescaped star, over source tables. */
function variableRunnerPrefix(
  content: string,
  allowedRunners: readonly string[],
): boolean {
  const rule = content.replace(/:\*$/, " *");
  const prefix = /^(?:\\[*\\]|[^*])*/.exec(rule)?.[0] ?? "";
  if (prefix === rule) return false;
  const allowed = [...wrappers, ...allowedRunners];
  let consumed = 0;
  for (const [matched, captured = ""] of prefix.matchAll(whitespaceToken)) {
    const token = captured.replace(/['"]/g, "");
    if (commandStringFlag.test(token)) return true;
    if (
      !environmentOrOption.test(token) &&
      !allowed.includes(baseCommand(token))
    )
      return false;
    consumed += matched.length;
  }
  const tail = prefix.slice(consumed).trim().replace(/['"]/g, "");
  const command = baseCommand(tail);
  return (
    environmentOrOption.test(tail) ||
    /^(?:[/~\\]|[a-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(tail) ||
    (command !== "" &&
      allowed.some(
        (value) => !value.includes(" ") && value.startsWith(command),
      ))
  );
}
/** U9r: source broad interpreter and subcommand allow-pattern classifier. */
export function nativeBroadRunnerAllow(
  content: string,
  allowedRunners: readonly string[],
): boolean {
  const rule = content.trim().toLowerCase();
  if (rule === "*") return true;
  for (const runner of allowedRunners) {
    const command = runner.toLowerCase();
    if (
      rule === command ||
      rule === `${command}:*` ||
      rule === `${command} *` ||
      rule === `${command}*`
    )
      return true;
    if (!rule.startsWith(`${command} `) || !rule.endsWith("*")) continue;
    const rest = rule.slice(command.length + 1);
    if (subcommandRunners.has(command)) {
      if (/[$`]/.test(rest)) return true;
      const commands = dangerousSubcommands[command];
      if (commands === "all") return true;
      const tokens = rest
        .replace(/[\s:*]+$/, "")
        .split(/\s+/)
        .filter(Boolean);
      let index = 0;
      for (; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === undefined || !token.startsWith("-")) break;
        const next = tokens[index + 1];
        if (!token.includes("=") && next !== undefined && !next.startsWith("-"))
          index++;
      }
      const subcommand = tokens[index];
      if (subcommand === undefined) {
        if (
          (command === "curl" || command === "wget") &&
          tokens.some((token) => token.includes("://"))
        )
          continue;
        return true;
      }
      if (commands?.has(subcommand)) return true;
      continue;
    }
    if (rest.startsWith("-")) {
      const beforeStar = rest.slice(0, -1);
      if (!(
        /^python[\d.]*$/.test(command) &&
        /^-m\s+\w+\.[\w.]+(\s*:|\s+)$/.test(beforeStar)
      ))
        return true;
    }
  }
  return false;
}

export function nativeBroadBashAllow(content: string | undefined): boolean {
  return (
    content === undefined ||
    content === "" ||
    variableRunnerPrefix(content, bashRunners) ||
    nativeBroadRunnerAllow(content, bashRunners)
  );
}
export function nativeBroadPowerShellAllow(
  content: string | undefined,
): boolean {
  if (content === undefined || content === "") return true;
  const rule = content.trim().toLowerCase();
  const allowed = [
    ...runners,
    "pwsh",
    "powershell",
    "cmd",
    "wsl",
    "iex",
    "invoke-expression",
    "icm",
    "invoke-command",
    "start-process",
    "saps",
    "start",
    "start-job",
    "sajb",
    "start-threadjob",
    "invoke-wmimethod",
    "iwmi",
    "invoke-cimmethod",
    "icim",
    "wmic",
    "register-objectevent",
    "register-engineevent",
    "register-wmievent",
    "register-scheduledjob",
    "new-pssession",
    "nsn",
    "enter-pssession",
    "etsn",
    "add-type",
    "new-object",
  ];
  if (variableRunnerPrefix(content, allowed)) return true;
  for (const command of allowed) {
    if (
      rule === command ||
      rule === `${command}:*` ||
      rule === `${command}*` ||
      rule === `${command} *` ||
      (rule.startsWith(`${command} -`) && rule.endsWith("*"))
    )
      return true;
    const separator = command.indexOf(" ");
    const executable =
      separator === -1
        ? `${command}.exe`
        : `${command.slice(0, separator)}.exe${command.slice(separator)}`;
    if (
      rule === executable ||
      rule === `${executable}:*` ||
      rule === `${executable}*` ||
      rule === `${executable} *` ||
      (rule.startsWith(`${executable} -`) && rule.endsWith("*"))
    )
      return true;
  }
  return false;
}
