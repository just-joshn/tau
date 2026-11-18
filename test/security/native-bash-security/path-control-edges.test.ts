import { expect, test } from "bun:test";
import { posix } from "node:path";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import {
  createNativeBashSecurityPathControl,
  type NativeBashSecurityPathHost,
} from "../../../src/native-bash-security/path-control.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityPolicy as Policy,
} from "../../../src/native-bash-security/security-types.js";
import { fixture, known, policy } from "./security-fixture.js";

type PathHost = NativeBashSecurityPathHost;
interface Patch {
  host?: Partial<Omit<PathHost, "filesystem" | "filePolicy">>;
  filesystem?: Partial<PathHost["filesystem"]>;
  filePolicy?: Partial<PathHost["filePolicy"]>;
}

// Paths with glob characters and paths in `missing` do not exist on this
// virtual disk, so canonical walks climb past them.
function disk(
  missing: ReadonlySet<string> = new Set(),
): Partial<PathHost["filesystem"]> {
  return {
    canonical: (path, s) =>
      known(
        {
          resolvedPath: path,
          isCanonical: !/[*?[]/.test(path) && !missing.has(path),
          isSymlink: false,
        },
        s,
      ),
  };
}

function owner(options: Parameters<typeof fixture>[0] = {}, patch: Patch = {}) {
  const f = fixture(options);
  const preparation = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const host: NativeBashSecurityPathHost = {
    ...f.host,
    protectedRoots: (s) => known([], s),
    workingDirectories: (_p, s) => known(["/work"], s),
    suggestionDirectory: (path, s) => known(posix.dirname(path), s),
    readDirectorySuggestion: (path, destination, s) =>
      known(
        {
          type: "addRules",
          rules: [{ toolName: "Read", ruleContent: path + "/**" }],
          behavior: "allow",
          destination,
        },
        s,
      ),
    feature: (_key, _default, s) =>
      known({ value: true, source: "virtual-test" }, s),
    mountedDriveRmPromptDisabled: (s) => known(false, s),
    ...patch.host,
    filesystem: { ...f.host.filesystem, ...disk(), ...patch.filesystem },
    filePolicy: { ...f.host.filePolicy, ...patch.filePolicy },
  };
  const controller = createNativeBashSecurityPathControl(
    f.semantic,
    preparation,
    host,
  );
  async function run(command: string, p: Policy = policy(), cd = false) {
    const r = await f.semantic.analyze(command);
    if (r.kind !== "simple") throw new Error(`${command}: ${r.reason}`);
    return controller.withPolicyScope(p, "/work", () =>
      controller.native.mD(
        { command },
        "/work",
        p,
        cd,
        r.commands.flatMap((c) => c.redirects),
        r.commands,
        undefined,
      ),
    ).result;
  }
  // The text-only entry: no semantic commands, so commands and redirects
  // come from the preparation projection of the raw command string.
  function text(command: string, p: Policy = policy(), cd = false) {
    return controller.withPolicyScope(p, "/work", () =>
      controller.native.mD({ command }, "/work", p, cd, undefined, undefined),
    ).result;
  }
  return { ...f, host, controller, run, text };
}

function kind(d: Decision) {
  const reason = d.decisionReason;
  if (reason?.type === "safetyCheck")
    return `${d.behavior}:${reason.circuitBreaker ?? "safety"}`;
  if (reason?.type === "other")
    return `${d.behavior}:${reason.bashMissKind ?? "other"}`;
  return `${d.behavior}:${reason?.type ?? "none"}`;
}

test("wrappers that run the next command keep its Read deny", async () => {
  const f = owner({ deny: "/work/denied" });
  const runs = [
    "time -- cat denied",
    "/usr/bin/nohup cat denied",
    "timeout 5 cat denied",
    "timeout 1.5s cat denied",
    "timeout -k 5 10 cat denied",
    "timeout -k5 10 cat denied",
    "timeout -s KILL 10 cat denied",
    "timeout --signal=KILL 10 cat denied",
    "timeout --kill-after 5 10 cat denied",
    "timeout --foreground --preserve-status --verbose -v 10 cat denied",
    "timeout -- 10 cat denied",
    "nice cat denied",
    "nice -- cat denied",
    "nice -n 5 cat denied",
    "nice -n 5 -- cat denied",
    "nice -5 cat denied",
    "nice -5 -- cat denied",
    "stdbuf -o L cat denied",
    "stdbuf -oL cat denied",
    "stdbuf --output=L cat denied",
    "env A=1 cat denied",
    "env -i -0 -v cat denied",
    "env -u HOME cat denied",
    "command cat denied",
    "command -pp -- cat denied",
    "builtin cat denied",
    "builtin -- cat denied",
    "noglob cat denied",
  ];
  for (const command of runs)
    expect([command, kind(await f.run(command))]).toEqual([
      command,
      "deny:rule",
    ]);
});

test("wrappers that do not run a following command leave nothing to check", async () => {
  const f = owner({ deny: "/work/denied" });
  // Each of these either fails before running anything or does not run its
  // operand (command -v only looks it up), so no path is read.
  const inert = [
    "timeout",
    "timeout -k",
    "timeout soon cat denied",
    "timeout --bogus 10 cat denied",
    "timeout -x 10 cat denied",
    "stdbuf cat denied",
    "stdbuf -oL",
    "stdbuf -x cat denied",
    "env A=1",
    "env -x cat denied",
    "command",
    "command -v cat denied",
    "builtin",
    "builtin --",
    "noglob",
  ];
  for (const command of inert)
    expect([command, (await f.run(command)).behavior]).toEqual([
      command,
      "passthrough",
    ]);
});

type Mode = "plain" | "block" | "accept" | "cd" | "cdBlock";
const modeNames: readonly Mode[] = [
  "plain",
  "block",
  "accept",
  "cd",
  "cdBlock",
];
const modes: Record<Mode, { p: Policy; cd: boolean }> = {
  plain: { p: policy(), cd: false },
  block: {
    p: policy({ blockReadsOutsideWorkingDirectories: true }),
    cd: false,
  },
  accept: { p: policy({ mode: "acceptEdits" }), cd: false },
  cd: { p: policy(), cd: true },
  cdBlock: {
    p: policy({ blockReadsOutsideWorkingDirectories: true }),
    cd: true,
  },
};

// Each row: command, then the expected decision kind per mode. The fixture
// denies Read of /secret and Edit of /work/locked, and its read fence
// holds everything outside /work.
async function table(rows: [string, Partial<Record<Mode, string>>][]) {
  const f = owner(
    { deny: "/secret", writeDeny: "/work/locked" },
    {
      filePolicy: {
        outsideReadBlocked: (path, _spellings, _p, s) =>
          known(path !== "/work" && !path.startsWith("/work/"), s),
      },
    },
  );
  for (const [command, expected] of rows)
    for (const mode of modeNames) {
      const want = expected[mode];
      if (want === undefined) continue;
      const { p, cd } = modes[mode];
      const got = kind(await f.run(command, p, cd));
      expect([command, mode, got]).toEqual([command, mode, want]);
    }
}

test("under the read block, a glob that can expand to '..' asks", async () => {
  const runtime = "ask:outsideReadsBlocked";
  const checked = "passthrough:none";
  await table([
    ["'' x", { block: checked }],
    ["cat .*", { plain: checked, block: runtime }],
    ["cat .?", { block: runtime }],
    ["cat sub/.*/x", { block: runtime }],
    ["cat [.][.]", { block: runtime }],
    ["cat '[!a].'", { block: runtime }],
    ["cat '.[!x]'", { block: runtime }],
    ["cat '.[a]]'", { block: runtime }],
    ["cat '[[:punct:]][[:punct:]]'", { block: runtime }],
    // An invalid range is treated as possibly matching.
    ["cat '.[z-a]'", { block: runtime }],
    // Leading * and ? never match dot entries; these cannot be '..'.
    ["cat *", { block: checked }],
    ["cat ?x", { block: checked }],
    ["cat [a]b", { block: checked }],
    ["cat x[ab]", { block: checked }],
    ["cat '.['", { block: checked }],
    ["cat '.*['", { block: checked }],
    ["cat '[[:alpha:]]'", { block: checked }],
    ["cat '[]a].'", { block: checked }],
    ["cat '[^.]'", { block: checked }],
    // awk can open files named inside its program.
    ["awk '{getline}' f", { plain: checked, block: runtime }],
    ["awk '{print}' f", { block: checked }],
  ]);
});

test("git globs are checked only where the shell expands them into read paths", async () => {
  // /secret/* expands to files inside the Read-denied /secret.
  const fenced = "deny:rule";
  await table([
    // git log takes pathspecs; it does not open the expanded files.
    [
      "git log /secret/*",
      { plain: "passthrough:none", block: "passthrough:none" },
    ],
    ["git -c core.pager=less log /secret/*", { plain: "passthrough:none" }],
    // diff and grep read file contents; config that can run aliases or
    // relocate the repository, and env-changed git, lose the exemption.
    ["git diff /secret/*", { plain: fenced, block: fenced }],
    ["git grep x /secret/*", { plain: fenced }],
    ["git /secret/*", { plain: fenced }],
    ["HOME=/x git log /secret/*", { plain: fenced }],
    ["env git log /secret/*", { plain: fenced }],
    ["git -c alias.x=y log /secret/*", { plain: fenced }],
    ["git --git-dir=/x log /secret/*", { plain: fenced }],
    ["git --bare log /secret/*", { plain: fenced }],
    ["git --exec-path=/x log /secret/*", { plain: fenced }],
    ["git --config-env=a=B log /secret/*", { plain: fenced }],
    ["git -c include.path=/x log /secret/*", { plain: fenced }],
    ["git log '/secret/*'", { plain: "passthrough:none" }],
  ]);
});

test("cp and mv check every operand, attached destinations and flags", async () => {
  const flagged = "ask:flag-validation";
  await table([
    [
      "cp a /work/locked",
      { plain: "deny:rule", block: "deny:rule", cd: "deny:rule" },
    ],
    ["cp -t /work/locked a", { plain: "deny:rule" }],
    ["cp --target-directory=/work/locked a", { plain: "deny:rule" }],
    ["cp -t/work/locked a", { plain: "deny:rule" }],
    ["mv a b /work/locked", { plain: "deny:rule" }],
    ["cp -S .bak -b a /work/locked", { plain: "deny:rule" }],
    ["cp -r /secret /work/x", { plain: "deny:rule", block: "deny:rule" }],
    ["cp --suffix=.x -b a b", { plain: flagged, block: flagged }],
    ["cp --parents a/b /work/dir", { plain: flagged }],
    ["cp -T a b", { plain: flagged }],
    [
      "cp /outside/a /work/x",
      {
        plain: "ask:none",
        block: "ask:outsideReadsBlocked",
        cd: "ask:cd-compound-write",
        cdBlock: "ask:outsideReadsBlocked",
      },
    ],
    [
      "mv /work/a /outside/b",
      {
        plain: "ask:none",
        block: "ask:none",
        cdBlock: "ask:cd-compound-write",
      },
    ],
    ["cp a .", { plain: "ask:none", accept: "passthrough:none" }],
    ["cp a dir/", { plain: "ask:none", accept: "passthrough:none" }],
  ]);
});

test("links, pushd and env -C targets are read-checked under the read block", async () => {
  const outside = "ask:outsideReadsBlocked";
  await table([
    [
      "ln -s /secret x",
      { plain: "passthrough:none", block: "deny:rule", cdBlock: "deny:rule" },
    ],
    ["ln /outside/f x", { plain: "passthrough:none", block: outside }],
    ["ln -t /work/d /outside/f", { block: outside }],
    ["link /outside/f y", { block: outside }],
    ["/bin/ln a b", { block: "passthrough:none" }],
    ["pushd", { block: "passthrough:none" }],
    ["pushd sub", { block: "passthrough:none" }],
    ["pushd /outside", { plain: "passthrough:none", block: outside }],
    ["pushd /secret", { block: "deny:rule" }],
    // Traversal is not resolved for a directory change.
    ["pushd /work/a/../b", { block: outside }],
    ["env -C /outside cat f", { plain: "passthrough:none", block: outside }],
    ["env --chdir /outside cat f", { block: outside }],
    ["env -C", { block: "passthrough:none" }],
  ]);
});

test("input and output redirects are checked by direction", async () => {
  await table([
    [
      "cat < /outside/f",
      { plain: "ask:outsideReadsBlocked", block: "ask:outsideReadsBlocked" },
    ],
    [
      "cat < *.txt",
      { plain: "ask:shell-expansion", block: "ask:shell-expansion" },
    ],
    ["cat < .*", { block: "ask:outsideReadsBlocked" }],
    ["cat < /work/*/../f", { block: "ask:outsideReadsBlocked" }],
    ["cat < /outside/f", { cdBlock: "ask:outsideReadsBlocked" }],
    [
      "cat < /secret",
      { plain: "deny:rule", block: "deny:rule", cd: "deny:rule" },
    ],
    ["cat < sub/f", { plain: "passthrough:none", cd: "ask:shell-expansion" }],
    [
      "echo x > /outside/f",
      { plain: "ask:none", block: "ask:none", cd: "ask:cd-compound-redirect" },
    ],
    ["echo x >| out", { plain: "ask:none", cd: "ask:cd-compound-redirect" }],
    ["echo x &>> out", { plain: "ask:none" }],
    ["echo x >&out", { plain: "ask:none" }],
    ["echo x > /work/locked", { plain: "deny:rule", cd: "deny:rule" }],
    ["cat <&3", { plain: "passthrough:none", block: "passthrough:none" }],
    ["cat <<< hi", { block: "passthrough:none" }],
    ["echo x > ~/f", { plain: "ask:shell-expansion" }],
    [
      "echo x > /dev/null",
      { plain: "passthrough:none", cd: "passthrough:none" },
    ],
    ["cat < /dev/stdin", { plain: "passthrough:none" }],
  ]);
});
