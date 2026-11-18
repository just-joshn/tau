import { expect, test } from "bun:test";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import {
  createNativeBashSecurityPathControl,
  type NativeBashSecurityPathHost,
} from "../../../src/native-bash-security/path-control.js";
import { createNativeBashSecurityGitStructure } from "../../../src/native-bash-security/git-structure.js";
import { fixture, known, policy } from "./security-fixture.js";

// The detector answers one question: could this command create or replace
// HEAD, objects/, refs/ or hooks/ in the working directory, or in a directory
// between it and the session's original working directory? A yes turns the
// directory into something git would read as a bare repository.

interface Options {
  platform?: "macos" | "windows";
  original?: string;
  realpath?: ReadonlyMap<string, string | undefined>;
  symlinks?: readonly string[];
  lstatFails?: boolean;
}

function owner(options: Options = {}) {
  const f = fixture();
  const realpathCalls: string[] = [];
  const lstatCalls: string[] = [];
  const preparation = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const original =
    options.original ?? (options.platform === "windows" ? "C:\\work" : "/work");
  const host: NativeBashSecurityPathHost = {
    ...f.host,
    platform: options.platform ?? "macos",
    originalWorkingDirectory: (s) => known(original, s),
    pathPrimitive: (_kind, path, s) => known(path, s),
    filesystem: {
      ...f.host.filesystem,
      realpathSpelling(path, s) {
        realpathCalls.push(path);
        const map = options.realpath;
        return known(map?.has(path) === true ? map.get(path) : path, s);
      },
      lstat(path, s) {
        lstatCalls.push(path);
        if (options.lstatFails === true)
          return known({ status: "error", error: new Error("EACCES") }, s);
        return known(
          {
            status: "stat",
            isSymbolicLink: options.symlinks?.includes(path) === true,
            isDirectory: false,
          },
          s,
        );
      },
    },
  };
  const path = createNativeBashSecurityPathControl(
    f.semantic,
    preparation,
    host,
  );
  const git = createNativeBashSecurityGitStructure(
    f.semantic,
    preparation,
    path,
    host,
  );
  async function writes(command: string, cwd = original) {
    const r = await f.semantic.analyze(command);
    if (r.kind !== "simple") throw new Error(r.reason);
    return git.withPolicyScope(policy(), cwd, () =>
      git.native.qOe(r.commands, cwd),
    ).result;
  }
  function scoped<T>(run: () => T, cwd = original) {
    return git.withPolicyScope(policy(), cwd, run).result;
  }
  return {
    ...f,
    preparation,
    path,
    host,
    git,
    writes,
    scoped,
    realpathCalls,
    lstatCalls,
  };
}

test("the git-structure owner refuses a path owner built over another preparation", () => {
  const f = owner();
  const other = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  expect(() =>
    createNativeBashSecurityGitStructure(f.semantic, other, f.path, f.host),
  ).toThrow("must be shared");
});

test("a git-structure check outside a policy scope fails instead of answering", () => {
  const f = owner();
  expect(() => f.git.native.Gde("HEAD", "/work")).toThrow(
    "Missing native git-structure invariant",
  );
});

test.each([
  // Writes that land on git structure in the working directory.
  ["mkdir -p HEAD/sub", true],
  ["mkdir -vp HEAD/sub", true],
  ["mkdir --parents HEAD/sub", true],
  ["mkdir --par HEAD/sub", true],
  ["mkdir -p a//HEAD/x", false],
  ["mkdir HEAD/sub", false],
  ["mkdir -p ordinary/sub", false],
  ["echo x > ~/HEAD", false],
  ["touch ~nobody/HEAD", true],
  ["touch ''", false],
  ["touch .", false],
  ["cat < HEAD", false],
  ["cat <<< HEAD", false],
  ["> ordinary", false],
  ["> hooks/pre-commit", true],
  ['touch "$PWD/x"', true],
  ['"$PWD/tool" x', true],
  // A copy into the working directory names its result after the source.
  ["cp /outside/HEAD .", true],
  ["cp /outside/notes .", false],
  ["cp /outside/notes /outside/HEAD .", true],
  ["mv /outside/objects /work", true],
  ["cp -r /outside/refs ./", true],
  ["cp /outside/HEAD /elsewhere", false],
  ["cp /outside/HEAD", false],
  ["cp -t . /outside/HEAD", true],
  ["cp --target-directory=. /outside/refs", true],
  ["cp --t . /outside/hooks", true],
  ["cp -t /work /outside/notes", false],
  ["cp -T /outside/notes .", true],
  ["cp --no-target-directory /outside/notes .", true],
  ["cp '/outside/*' .", true],
  ["cp /outside/. .", true],
  ["cp /outside/.. .", true],
  ["cp ~/HEAD .", true],
  ["cp ~/notes .", false],
  ["cp ~nobody/notes .", true],
  ["cp /outside/notes ~nobody", true],
  ["cp /outside/HEAD ~", false],
])("macOS write %p reaches git structure: %p", async (command, expected) => {
  expect(await owner().writes(command)).toBe(expected);
});

test("a copy into the home directory is judged against home when home is the working directory", async () => {
  const f = owner({ original: "/home/test" });
  expect(await f.writes("cp /outside/HEAD ~", "/home/test")).toBe(true);
  expect(await f.writes("cp /outside/notes ~", "/home/test")).toBe(false);
});

test.each([
  ["touch ../HEAD", "/work/sub", true],
  ["touch ../objects/pack", "/work/sub", true],
  ["touch ../sibling/HEAD", "/work/sub", false],
  ["touch ../../HEAD", "/work/sub", false],
  ["touch /HEAD", "/work/sub", false],
  ["touch ../..", "/work/sub/deep", false],
  ["cp /outside/HEAD ..", "/work/sub", true],
  ["cp /outside/HEAD ../..", "/work/sub", false],
  ["cp /outside/notes ..", "/work/sub", false],
  ["cp /outside/HEAD /x", "/", false],
  ["cp /outside/HEAD /", "/other", false],
])(
  "%p from %p reaches git structure between there and the original directory: %p",
  async (command, cwd, expected) => {
    expect(await owner().writes(command, cwd)).toBe(expected);
  },
);

test("a copy into a symbolic link that resolves to the working directory is a copy into it", async () => {
  const f = owner({
    realpath: new Map([["/work/alias", "/work"]]),
  });
  expect(await f.writes("cp /outside/HEAD alias")).toBe(true);
  expect(await f.writes("cp /outside/notes alias")).toBe(false);
});

test("paths the host cannot resolve keep their lexical spelling", async () => {
  const unresolved = new Map<string, string | undefined>([
    ["/work", undefined],
    ["/work/HEAD", undefined],
    ["/work/ordinary", undefined],
  ]);
  const f = owner({ realpath: unresolved });
  expect(await f.writes("touch HEAD")).toBe(true);
  expect(await f.writes("touch ordinary")).toBe(false);
  expect(await f.writes("cp /outside/HEAD .")).toBe(true);
  const g = owner({ realpath: unresolved });
  expect(await g.writes("touch ../HEAD", "/work/sub")).toBe(true);
});

test.each([
  ["touch .vol/../HEAD", "/", true],
  ["touch net/host/../HEAD", "/", false],
  ["touch ./a/../HEAD/", "/work", true],
  ["touch /work/sub/../HEAD", "/work", true],
  ["touch /net/host/../HEAD", "/work", false],
])(
  "dot-dot walk of %p from %p never stats a network mount: %p",
  async (command, cwd, expected) => {
    const f = owner();
    expect(await f.writes(command, cwd)).toBe(expected);
    expect(f.lstatCalls.filter((p) => p.startsWith("/net/"))).toEqual([]);
  },
);

test("a failing lstat during a dot-dot walk is not a symbolic link", async () => {
  const f = owner({ lstatFails: true });
  expect(await f.writes("touch sub/../ordinary")).toBe(false);
  expect(await f.writes("touch sub/../HEAD")).toBe(true);
  expect(f.lstatCalls).toContain("/work/sub");
});

test("a symbolic link followed by dot-dot could land anywhere", async () => {
  const f = owner({ symlinks: ["/work/link"] });
  expect(await f.writes("touch /work/link/../ordinary")).toBe(true);
});

test("macOS volume-by-id paths count as git structure without being resolved", async () => {
  const f = owner();
  expect(await f.writes("touch /.vol/1/2")).toBe(true);
  expect(f.realpathCalls.some((p) => p.includes(".vol"))).toBe(false);
});

test.each([
  ["touch //server/HEAD", false],
  ["touch '//wsl$/Ubuntu/HEAD'", false],
  ["touch //wsl.localhost/../x", false],
  ["touch '/??/x'", false],
  ["touch 'a??b'", false],
])("macOS device-like spelling %p: %p", async (command, expected) => {
  expect(await owner().writes(command)).toBe(expected);
});

test("Windows UNC targets are never resolved through the host, WSL shares are", async () => {
  const f = owner({ platform: "windows" });
  expect(await f.writes("touch //server/share/HEAD")).toBe(false);
  expect(f.realpathCalls.some((p) => p.startsWith("\\\\server"))).toBe(false);
  expect(await f.writes("touch '//wsl$/Ubuntu/HEAD'")).toBe(false);
  expect(f.realpathCalls.some((p) => p.startsWith("\\\\wsl$"))).toBe(true);
});

test.each([
  ["touch HEAD", true],
  ["touch hooks/pre-commit", true],
  ["touch ordinary", false],
  ["touch C:HEAD", true],
  ["touch /c/work/HEAD", true],
  ["touch /c/work/ordinary", false],
  ["touch D:/x/HEAD", false],
  ["mkdir -p HEAD/sub", true],
  ["cp D:/x/HEAD .", true],
  ["cp D:/x/HEAD /c/work", true],
  ["cp D:/x/notes /c/work", false],
])("Windows write %p reaches git structure: %p", async (command, expected) => {
  expect(await owner({ platform: "windows" }).writes(command)).toBe(expected);
});

test("a Windows copy into a directory on another drive than the original is not judged", async () => {
  const f = owner({ platform: "windows" });
  expect(await f.writes("cp D:/o/HEAD ..", "D:\\x\\y")).toBe(false);
});

test("undefined command slots are skipped", () => {
  const f = owner();
  expect(f.scoped(() => f.git.native.qOe([undefined], "/work"))).toBe(false);
});

test("the network alias cache keeps answering correctly past its size bound", () => {
  const n = owner().git.native;
  for (let i = 0; i < 1100; i++)
    expect(n.KPe(`/net/host${i}/x`)).toBe(`/net/host${i}`);
  expect(n.KPe("/net/host0/x")).toBe("/net/host0");
  expect(n.KPe("/plain/path")).toBeNull();
  expect(n.KPe("/plain/path")).toBeNull();
  expect(n.KPe(`/net/host/${"a".repeat(5000)}`)).toBe("/net/host");
  expect(n.Va("/Network/Servers/h/x")).toBe(true);
  expect(n.Va("/home/x")).toBe(false);
});

test.each([
  ["", false],
  ["'' HEAD", false],
  ["echo HEAD", false],
  ["cp /outside/HEAD ../..", true],
  ["cp /outside/notes/ .", false],
  ["mv /outside/refs/ ./", true],
  ["cp a b ''", false],
  ["touch objects", true],
])("raw fallback for %p reaches git structure: %p", (command, expected) => {
  expect(owner().git.native.zde(command)).toBe(expected);
});
