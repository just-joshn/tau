import { describe, it, expect } from "bun:test";
import { createNativeBashSecurityArguments } from "../../src/native-bash-security/arguments.js";
const owner = createNativeBashSecurityArguments("macos", () => "/home/tester");
function paths(command: string, argv: string[]) {
  const extract = owner.extractors[command];
  if (extract === undefined) throw new Error("Missing extractor");
  return extract(argv);
}
describe("complete native path argument families", () => {
  it("retains every source command family and operation", () => {
    expect(Object.keys(owner.extractors)).toHaveLength(54);
    expect(Object.keys(owner.extractors).sort()).toEqual(
      Object.keys(owner.operations).sort(),
    );
    expect(Object.keys(owner.verbs).sort()).toEqual(
      Object.keys(owner.operations).sort(),
    );
    expect(paths("cd", [])).toEqual(["/home/tester"]);
    expect(paths("cd", ["-"])).toEqual(["-"]);
    expect(paths("cd", ["--", " dir ", "ignored"])).toEqual([" dir "]);
    expect(paths("ls", ["-al"])).toEqual(["."]);
  });
  it("uses native first operand flag boundary instead of option reparsing", () => {
    expect(paths("cat", ["-n", "a", "-literal", "b"])).toEqual([
      "a",
      "-literal",
      "b",
    ]);
    expect(paths("tee", ["--", "/dev/null", "/dev/stdin", " note "])).toEqual([
      "/dev/stdin",
      " note ",
    ]);
    expect(
      paths("cut", ["-d", ":", "-f2", "file", "--fields=literal"]),
    ).toEqual(["file", "--fields=literal"]);
    expect(paths("cut", ["--unknown", "not-a-value", "later"])).toEqual([
      "not-a-value",
      "later",
    ]);
    expect(paths("pr", ["-e8", "--header", "title", "input"])).toEqual([
      "input",
    ]);
  });
  it("includes find reference files without treating expression arguments as roots", () => {
    expect(
      paths("find", [
        "-H",
        "root",
        "-newer",
        "ref",
        "-name",
        "*.ts",
        "-neweram",
        "other",
      ]),
    ).toEqual(["root", "ref", "other"]);
    expect(paths("find", ["-name", "*.ts"])).toEqual(["."]);
    expect(paths("find", ["--", "-literal", "雪"])).toEqual(["-literal", "雪"]);
  });
  it("tracks regexp and pattern file options including attached forms", () => {
    expect(
      paths("grep", ["-fpattern", "--exclude-from=exclude", "-e", "x", "file"]),
    ).toEqual(["pattern", "exclude", "file"]);
    expect(paths("grep", ["-r", "pattern"])).toEqual(["."]);
    expect(paths("rg", ["--ignore-file", "ignore", "pattern"])).toEqual([
      "ignore",
    ]);
    expect(
      paths("awk", ["-F", ":", "-f", "code.awk", "data", "-fmore"]),
    ).toEqual(["code.awk", "data", "more", "-fmore"]);
  });
  it("distinguishes sed programs and program files", () => {
    expect(paths("sed", ["-f", "program.sed", " data "])).toEqual([
      "program.sed",
      " data ",
    ]);
    expect(paths("sed", ["-e", "s/a/b/", "file"])).toEqual(["file"]);
    expect(paths("sed", ["s/a/b/", "-literal"])).toEqual(["-literal"]);
  });
  it("extracts jq file providers, slurp arguments and source file options", () => {
    expect(
      paths("jq", [
        "--slurpfile",
        "name",
        "data.json",
        "--arg",
        "x",
        "value",
        ".",
        "input",
      ]),
    ).toEqual(["data.json", ".", "input"]);
    expect(paths("jq", ["--from-file=code.jq", "in.json"])).toEqual([
      "code.jq",
      "in.json",
    ]);
    expect(paths("jq", ["--", ".", "-literal"])).toEqual(["-literal"]);
  });
  it("preserves git directory stack and diff device exclusions", () => {
    expect(
      paths("git", [
        "-C",
        "repo",
        "-C",
        "sub",
        "diff",
        "--",
        "file",
        "/dev/null",
      ]),
    ).toEqual(["repo/sub/file"]);
    expect(paths("git", ["--work-tree=/work", "grep", "pattern"])).toEqual([
      "/work",
    ]);
    expect(paths("git", ["status"])).toEqual([]);
    expect(
      paths("git", ["-C", "repo", "grep", "-f", "patterns", "file"]),
    ).toEqual(["repo/patterns", "repo/file"]);
  });
  it("preserves ambiguous cp/mv destinations and source flag positions", () => {
    const n = owner.native;
    expect(n.wSn(["source", "--target-d=dest", "-S=~", "-b"])).toEqual([
      { name: "t", value: "dest", afterOperand: true },
      { name: "S", value: "=~", afterOperand: true },
      { name: "S", value: "~", afterOperand: true },
      { name: "b", afterOperand: true },
    ]);
    expect(n.fat("cp", ["--target-d=dest", "-t=other"])).toEqual({
      targetDirectoryGiven: true,
      attachedDestinations: ["dest", "=other", "other"],
    });
    expect(n.hat(["-t", "dest"], ["dest", "source"], ["other"])).toEqual([
      "dest",
      "other",
      "source",
    ]);
    expect(n.yat(["a", "dir/雪", "."], ["dst/"])).toEqual(["dst/a", "dst/雪"]);
    expect(n.vSn(["-p", "a", "b"])).toBe(true);
    expect(n.vSn(["a", "-p", "b"])).toBe(false);
    expect(n.TSn([], ["dir/"])).toBe(true);
    expect(n.lSn("cp", ["src", "dest"])).toEqual(["src"]);
  });
  it("recognizes only source-approved flag validation", () => {
    expect(owner.validators.cp?.(["a", "b"])).toBe(true);
    expect(owner.validators.cp?.(["--", "a", "b"])).toBe(false);
    expect(owner.validators.cd?.(["-P", "--", "a"])).toBe(true);
    expect(owner.validators.cd?.(["a", "b"])).toBe(false);
    expect(
      paths("man", [
        "-C",
        "config",
        "3",
        "printf",
        "./local.1",
        "--local-file",
        "雪.1",
      ]),
    ).toEqual(["config", "3", "printf", "./local.1", "雪.1"]);
  });
});
