import { expect, test } from "bun:test";
import { createNativeBashSecurityArguments } from "../../../src/native-bash-security/arguments.js";

// Each extractor names the file operands a command reads or writes, so the
// permission check can judge every path the command touches. Options that
// take a value consume it; a pattern or program operand is not a file; files
// named through options (-f, --file, --slurpfile) are files.

const macos = createNativeBashSecurityArguments("macos", () => "/home/tester");
const windows = createNativeBashSecurityArguments("windows", () => "C:\\home");

function paths(command: string, argv: string[], owner = macos) {
  const extract = owner.extractors[command];
  if (extract === undefined) throw new Error(`Missing extractor ${command}`);
  return extract(argv);
}

test.each<[string, string[], string[]]>([
  // Option tables: valued options consume the next word, attached ones do not.
  ["cut", ["-c1-3", "f"], ["f"]],
  ["cut", ["-d", ":", "f"], ["f"]],
  ["cut", ["--delimiter=:", "f"], ["f"]],
  ["cut", ["--delimiter", ":", "f"], ["f"]],
  ["cut", ["-s", "-f1", "f"], ["f"]],
  ["cut", ["-x", "-d", "f"], ["f"]],
  ["cut", ["-5", "f"], ["f"]],
  ["cut", ["--", "-f"], ["-f"]],
  ["cut", ["-", "x"], ["-", "x"]],
  ["cut", ["-sz"], []],
  ["pr", ["--expand-tabs", "f"], ["f"]],
  ["pr", ["-e", "f"], ["f"]],
  ["column", ["-t", "-s", ",", "f"], ["f"]],
  ["tac", ["-s", "x", "f"], ["f"]],
  ["fold", ["-w80", "f"], ["f"]],
  ["comm", ["-12", "a", "b"], ["a", "b"]],
  ["numfmt", ["--header", "f"], ["f"]],
  // grep and rg: the first operand is the pattern unless -e or -f gave one.
  ["grep", ["-e", "pat", "f"], ["f"]],
  ["grep", ["pat", "f"], ["f"]],
  ["grep", ["-f", "pats", "f"], ["pats", "f"]],
  ["grep", ["--file=pats", "f"], ["pats", "f"]],
  ["grep", ["-rf", "pats", "f"], ["pats", "f"]],
  ["grep", ["-fpats", "f"], ["pats", "f"]],
  ["grep", ["-epat", "f"], ["f"]],
  ["grep", ["--exclude-from", "ex", "p", "f"], ["ex", "f"]],
  ["grep", ["--exclude-from=ex", "p", "f"], ["ex", "f"]],
  ["grep", ["--", "-pat", "f"], ["f"]],
  ["grep", ["pat", "f", "-fpats"], ["f", "pats", "-fpats"]],
  ["grep", ["-m", "3", "pat", "f"], ["f"]],
  ["grep", ["--include=*.ts", "pat", "f"], ["f"]],
  ["rg", ["pat"], ["."]],
  ["rg", ["-t", "ts", "pat", "src"], ["src"]],
  // awk: the program is not a file unless it came from -f.
  ["awk", ["-f", "prog", "in"], ["prog", "in"]],
  ["awk", ["--file=prog", "in"], ["prog", "in"]],
  ["awk", ["-F", ":", "{print}", "in"], ["in"]],
  ["awk", ["-F:", "{print}", "in"], ["in"]],
  ["awk", ["-v", "x=1", "{print}", "in"], ["in"]],
  ["awk", ["-e", "{print}", "in"], ["in"]],
  ["awk", ["--", "{print}", "in"], ["in"]],
  ["awk", ["-W", "{print}", "in"], ["in"]],
  ["awk", ["{print}", "in", "-fprog"], ["in", "prog", "-fprog"]],
  ["awk", ["-f"], []],
  // sed: the script is not a file unless it came from -f.
  ["sed", ["-f", "script", "in"], ["script", "in"]],
  ["sed", ["-e", "s/a/b/", "in"], ["in"]],
  ["sed", ["--expression", "s/a/b/", "in"], ["in"]],
  ["sed", ["-n", "p", "in"], ["in"]],
  ["sed", ["-ne", "p", "in"], ["p", "in"]],
  ["sed", ["--", "s/a/b/", "f"], ["f"]],
  ["sed", ["-f"], []],
  // jq: the filter is not a file; -f, --slurpfile and --rawfile name files.
  ["jq", ["-f", "prog", "in"], ["prog", "in"]],
  ["jq", ["--from-file=prog", "in"], ["prog", "in"]],
  ["jq", ["--slurpfile", "n", "file", ".", "in"], ["file", "in"]],
  ["jq", ["--rawfile", "n"], []],
  ["jq", ["--indent", "2", ".", "in"], ["in"]],
  ["jq", ["--arg=a", ".", "in"], ["in"]],
  ["jq", ["-e", ".", "in"], ["in"]],
  ["jq", [".", "in"], ["in"]],
  ["jq", ["--", ".", "in"], ["in"]],
  ["jq", ["-f"], []],
  // git reaches files only through grep and diff, relative to -C/--work-tree.
  ["git", ["-C", "repo", "diff", "a"], ["repo/a"]],
  ["git", ["--work-tree=wt", "grep", "x"], ["wt"]],
  ["git", ["grep", "x"], ["."]],
  ["git", ["-C", "/abs", "grep", "-e", "x", "f"], ["/abs/f"]],
  ["git", ["-C", "a", "-C", "b", "diff", "x"], ["a/b/x"]],
  ["git", ["-C", "a", "-C", "/b", "diff", "x"], ["/b/x"]],
  ["git", ["-C", "~/r", "diff", "x", "/y", "~/z"], ["~/r/x", "/y", "~/z"]],
  ["git", ["-c", "k=v", "diff", "x"], ["x"]],
  ["git", ["diff", "--", "a", "/dev/null"], ["a"]],
  ["git", ["diff", "-", "x", "--stat"], ["-", "x"]],
  ["git", ["diff", "--", "--stat"], ["--stat"]],
  ["git", ["status"], []],
  ["git", ["-C"], []],
  // man reads files only when given a path or --local-file.
  ["man", ["-l", "page.1"], ["page.1"]],
  ["man", ["--local-file", "page.1"], ["page.1"]],
  ["man", ["ls"], []],
  ["man", ["./ls.1"], ["./ls.1"]],
  ["man", ["-C", "conf", "ls"], ["conf"]],
  ["man", ["--config-file", "conf", "ls"], ["conf"]],
  ["man", ["-M/opt/man", "ls"], ["/opt/man"]],
  ["man", ["--manpath=~/man", "ls"], ["~/man"]],
  ["man", ["-Mx~y", "ls"], ["~y"]],
  // Plain commands.
  ["tr", ["-d", "a", "f"], ["f"]],
  ["tr", ["a", "b", "f"], ["f"]],
  ["tee", ["-a", "f", "/dev/null"], ["f"]],
  ["find", ["-L", "dir"], ["dir"]],
  ["find", ["dir", "-newerac", "ref"], ["dir", "ref"]],
  ["find", ["dir", "-samefile"], ["dir"]],
  ["find", ["-name", "x", "late"], ["."]],
  ["cd", ["--", "x"], ["x"]],
])("%s %p names files %p", (command, argv, expected) => {
  expect(paths(command, argv)).toEqual(expected);
});

test("Windows git paths treat a drive path as absolute", () => {
  expect(paths("git", ["-C", "C:\\r", "diff", "x"], windows)).toEqual([
    "C:\\r/x",
  ]);
  expect(paths("cd", [], windows)).toEqual(["C:\\home"]);
});

test.each<[string[], { given: boolean; attached: string[] }]>([
  [["--target-directory=dir", "a"], { given: true, attached: ["dir"] }],
  [["--target", "dir", "a"], { given: true, attached: [] }],
  [["--no-target-directory", "a", "b"], { given: false, attached: [] }],
  [["-t", "dir", "a"], { given: true, attached: [] }],
  [["-vtdir", "a"], { given: true, attached: ["dir"] }],
  [["-t=dir", "a"], { given: true, attached: ["=dir", "dir"] }],
  [["a", "b"], { given: false, attached: [] }],
])("cp %p gives a target directory: %p", (argv, expected) => {
  expect(macos.native.fat("cp", argv)).toEqual({
    targetDirectoryGiven: expected.given,
    attachedDestinations: expected.attached,
  });
  expect(macos.native.fat("touch", argv)).toEqual({
    targetDirectoryGiven: false,
    attachedDestinations: [],
  });
});

test.each<[string[], string[]]>([
  [["--suffix=.bak", "a", "b"], ["b"]],
  [["--suffix", ".bak", "a", "b"], ["b"]],
  [["-S", ".bak", "a", "b"], ["b"]],
  [["-S.bak", "a", "b"], ["b"]],
  [
    ["-t", "dir", "a"],
    ["dir", "a"],
  ],
  [
    ["-tdir", "a"],
    ["dir", "a"],
  ],
  [
    ["-t=dir", "a"],
    ["=dir", "dir", "a"],
  ],
  [
    ["--target-directory=dir", "a"],
    ["dir", "a"],
  ],
  [
    ["--backup", "a", "-v", "b"],
    ["a", "b"],
  ],
  [
    ["a", "b", "--", "c"],
    ["b", "c"],
  ],
])("cp %p may land in %p", (argv, expected) => {
  expect(macos.native.hat(argv, paths("cp", argv), [])).toEqual(expected);
});

test.each<[string, string[], boolean]>([
  ["macos", ["dir/"], true],
  ["macos", ["."], true],
  ["macos", ["../.."], true],
  ["macos", ["dir"], false],
  ["windows", ["dir/"], false],
])(
  "on %s a copy into %p may land somewhere unexpected: %p",
  (platform, destinations, expected) => {
    const owner = platform === "windows" ? windows : macos;
    expect(owner.native.TSn([], destinations)).toBe(expected);
  },
);

test("a copy told not to treat the destination as a directory is uncertain", () => {
  expect(macos.native.TSn(["-T"], [])).toBe(true);
  expect(macos.native.TSn(["--no-target-directory"], [])).toBe(true);
  expect(macos.native.TSn(["-v"], [])).toBe(false);
});

test.each<[string[], boolean]>([
  [["--backup"], true],
  [["--parents"], true],
  [["--suffix=x"], true],
  [["-b"], true],
  [["-vS"], true],
  [["-v"], false],
])("copy options %p make backups or parents: %p", (argv, expected) => {
  expect(macos.native.ESn(argv)).toBe(expected);
});

test.each<[string[], boolean]>([
  [["a", "b"], true],
  [["-r", "a", "b"], true],
  [["-l", "a", "b"], false],
  [["--symbolic-link", "a", "b"], false],
  [["--link", "a", "b"], false],
  [["a", "-v", "b"], false],
  [["-", "b"], true],
  [["--", "a"], true],
  [["a", "--", "b"], false],
])("cp %p copies file contents: %p", (argv, expected) => {
  expect(macos.native.vSn(argv)).toBe(expected);
});

test.each<[string, string[], string[]]>([
  ["cp", ["a", "b", "c"], ["a", "b"]],
  ["mv", ["a"], []],
  ["sed", ["f"], ["f"]],
  ["cat", ["f"], []],
])("%s %p reads sources %p", (command, operands, expected) => {
  expect(macos.native.lSn(command, operands)).toEqual(expected);
});

test.each<[string, boolean]>([
  ["/dev/fd/3", true],
  ["/proc/self/fd/1", true],
  ["/proc/self/fd/3", false],
  ["/dev/stdin", true],
  ["/dev/sda", false],
])("%p is a standard stream, not a file: %p", (path, expected) => {
  expect(macos.native.UOe(path)).toBe(expected);
});

test.each<[string, string[], boolean]>([
  ["cp", ["a", "b"], true],
  ["cp", ["-r", "a", "b"], false],
  ["mv", ["a", "b"], true],
  ["mv", ["-f", "a", "b"], false],
  ["cd", ["a"], true],
  ["cd", ["-L", "a"], true],
  ["cd", ["--", "-a"], true],
  ["cd", ["a", "b"], false],
])("%s %p is a plain enough form: %p", (command, argv, expected) => {
  const validate = macos.validators[command];
  if (validate === undefined) throw new Error("Missing validator");
  expect(validate(argv)).toBe(expected);
});

test("the git option prefix stops at the first subcommand word", () => {
  expect(macos.native.dSn(["-C", "x", "--bare", "log"])).toEqual({
    index: 3,
    options: [{ opt: "-C", value: "x" }, { opt: "--bare" }],
  });
  expect(macos.native.Jit("--file=x", ["--file"])).toBe("x");
  expect(macos.native.Jit("--other=x", ["--file"])).toBeUndefined();
  expect(macos.native.Jit("plain", ["-f"])).toBeUndefined();
  expect(macos.native.jkn("", "x")).toBe("x");
  expect(macos.native.jkn("a//", "x")).toBe("a/x");
});
