import { expect, test } from "bun:test";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import { createNativeBashInlineScript } from "../../../src/native-bash-security/inline-script.js";
import { gitFixture } from "./git-fixture.js";
import { known, policy } from "./security-fixture.js";

// FOr reads the script of a shell -c invocation and, when it can, rewrites
// the positional parameters with the arguments that follow it, so the script
// can be judged as the inner shell would run it. A script it cannot rewrite
// faithfully keeps judged undefined.

function owner(home?: string) {
  const f = gitFixture();
  if (home !== undefined) f.host.home = (s) => known(home, s);
  const inline = createNativeBashInlineScript(
    f.semantic,
    f.git.preparation,
    f.git.pathOwner,
  );
  function read(argv: string[]) {
    return inline.withPolicyScope(policy(), "/work", () =>
      inline.native.FOr(argv),
    ).result;
  }
  return { ...f, inline, read };
}

test("an inline-script owner over another preparation is refused", () => {
  const f = owner();
  const other = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  expect(() =>
    createNativeBashInlineScript(f.semantic, other, f.git.pathOwner),
  ).toThrow("must be shared");
});

test.each<[string[], string | undefined]>([
  [["toybox", "sh", "-c", "echo x"], "echo x"],
  [["sh", "-c", "--", "echo x"], "echo x"],
  [["bash", "--rcfile", "f", "-c", "echo x"], "echo x"],
  [["ksh", "-o", "x", "-c", "echo"], "echo"],
  // Positional parameters take the arguments after the script.
  [["sh", "-c", "rm $1", "z", "~/x"], "rm /home/test/x"],
  [["sh", "-c", "rm $1", "z", "a b"], "rm a b"],
  [["sh", "-c", "rm $1", "z", "a;b"], "rm __INLINE_SHELL_VALUE__"],
  [["sh", "-c", "rm ${1}", "z", ""], "rm "],
  [["sh", "-c", "rm ${1:?}", "z", ""], "rm ${__INLINE_SHELL_GUARDED__:?}"],
  [["sh", "-c", "rm ${2:?}", "z"], "rm ${__INLINE_SHELL_GUARDED__:?}"],
  [["sh", "-c", "rm $*", "z", "a"], "rm a"],
  [["sh", "-c", "rm $9", "z"], "rm "],
  [["sh", "-c", 'rm "$@"'], "rm "],
  [["sh", "-c", 'echo "$@" "x', "z", "a"], 'echo "a" "x'],
  [["sh", "-c", "rm \\$1", "z", "a"], "rm \\$1"],
  [["sh", "-c", "echo $#", "z", "a", "b"], "echo 2"],
  [["sh", "-c", "rm $1$HOME", "z", "a"], "rm a$HOME"],
  [["sh", "-c", "set -o x; rm $1", "z", "a"], "set -o x; rm a"],
  [["sh", "-c", "set +x; rm $1", "z", "a"], "set +x; rm a"],
  [["sh", "-c", "sudo $CMD", "z"], "sudo $CMD"],
  // Brace expansions that cannot form a dangerous path are kept.
  [["sh", "-c", "rm a{b,c}"], "rm a{b,c}"],
  [["sh", "-c", "echo a{,b}/"], "echo a{,b}/"],
  [["sh", "-c", "echo a{b}c"], "echo a{b}c"],
  [["sh", "-c", "echo {1..3}"], "echo {1..3}"],
  // Anything that could change the reading is left unjudged.
  [["sh", "-c", "rm $1", "z", "~user"], undefined],
  [["sh", "-c", "set a; rm $1", "z", "a"], undefined],
  [["sh", "-c", "echo {a,b}{c,d}"], undefined],
  [["sh", "-c", "echo /{a,b}"], undefined],
  [["sh", "-c", "echo a{b,c}~"], undefined],
  [["sh", "-c", "echo a{.,b}"], undefined],
  [["ksh", "-ox", "-c", "echo"], undefined],
])("shell invocation %p is judged as %p", (argv, judged) => {
  expect(owner().read(argv)?.judged).toBe(judged);
});

test.each<[string[]]>([[[]], [["bash", "--unknown", "x"]], [["bash", "x"]]])(
  "%p is not an inline shell script",
  (argv) => {
    expect(owner().read(argv)).toBeUndefined();
  },
);

test.each<[string[], string | undefined, boolean]>([
  [["bash", "-c", "rm C:\\Users\\t\\x"], "rm $HOME\\x", true],
  [["bash", "-c", "rm 'C:\\Users\\t\\x'"], undefined, false],
  [["bash", "-c", "rm C:\\Users\\tx"], undefined, false],
  [["bash", "-c", "rm a\\C:\\Users\\t\\x"], undefined, false],
  [["bash", "-c", "rm $1", "z", "C:\\Users\\t"], "rm $HOME", true],
  [["bash", "-c", "rm $1", "z", "~/x"], "rm $HOME/x", true],
  [
    ["bash", "-c", "rm $1", "z", "C:\\Users\\t\\a;b"],
    "rm __INLINE_SHELL_VALUE__",
    true,
  ],
])(
  "with a Windows home, %p is judged as %p (home written: %p)",
  (argv, judged, homeWritten) => {
    const result = owner("C:\\Users\\t").read(argv);
    expect(result?.judged).toBe(judged);
    expect(result?.homeWritten).toBe(homeWritten);
  },
);

test.each<[string, boolean]>([
  ["sudo $CMD x", true],
  ["X=1 Y=2 rm x", true],
  ["echo X=rm", true],
  ["CMD=/bin/rm", false],
  ["CMD=/bin/rm; $CMD x", true],
  ["echo hi", false],
])("script %p may run rm: %p", (script, expected) => {
  expect(owner().inline.native.P8(script)).toBe(expected);
});

test("helpers read empty input as nothing", () => {
  const n = owner().inline.native;
  expect(n.tIe("")).toEqual([]);
  expect(n.Xlt("plain")).toBe(false);
  expect(n.P5e(undefined)).toBe("");
});
