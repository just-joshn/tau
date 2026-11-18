import { test, expect } from "bun:test";
import { createNativeBashLiteralRemoval } from "../../../src/native-bash-security/literal-removal.js";
import { gitFixture } from "./git-fixture.js";
import { policy, known } from "./security-fixture.js";
function owner() {
  const f = gitFixture();
  f.host.pathPrimitive = (_kind, path, s) => known(path, s);
  const literal = createNativeBashLiteralRemoval(
    f.semantic,
    f.git.preparation,
    f.git.pathOwner,
  );
  return {
    ...f,
    literal,
    run<T>(check: () => T) {
      return literal.withPolicyScope(policy(), "/work", check).result;
    },
  };
}
test("literal variable removal guard returns complete source candidate metadata", () => {
  const f = owner();
  const candidate = f.run(() => f.literal.native.FOe('rm -rf "$BUILD/*"'));
  expect(candidate).toEqual({
    command: "rm",
    target: '"$BUILD/*"',
    invocation: 'rm -rf "$BUILD/*"',
    reparsed: false,
  });
  if (candidate === null) throw new Error("Missing candidate");
  const decision = f.literal.native.LOe(candidate, false);
  expect(decision.behavior).toBe("ask");
  if (decision.decisionReason?.type === "safetyCheck") {
    expect(decision.decisionReason.circuitBreaker).toBe("dangerousRemoval");
    expect(decision.decisionReason.removalRule).toBe("variable_path");
  } else throw new Error("Missing source removal reason");
  expect(decision.message).toContain("${BUILD:?}");
});
test("native root-child guard uses exact source alternatives and known-set variable semantics", () => {
  const f = owner();
  const n = f.literal.native;
  for (const child of [
    "etc",
    "nix",
    "snap",
    "private",
    "cores",
    "lost+found",
  ]) {
    const c = f.run(() =>
      n.FOe(`rm -rf "$BUILD/${child}"`, { mayBeUnset: () => true }),
    );
    expect(c?.rootChild).toBe(child);
  }
  expect(
    f.run(() => n.FOe('rm -rf "$BUILD/cache"', { mayBeUnset: () => true })),
  ).toBeNull();
  expect(
    f.run(() => n.FOe('rm -rf "$HOME/etc"', { mayBeUnset: () => true })),
  ).toBeNull();
});
test("source wrappers, find execution and inline shell strings retain removal targets", () => {
  const f = owner();
  const n = f.literal.native;
  for (const command of [
    'sudo env X=1 rm -rf "$BUILD/"',
    'find . -exec rm -rf "$BUILD/*" {} \\;',
    "bash -c 'rm -rf \"$BUILD/*\"'",
  ]) {
    expect(f.run(() => n.FOe(command))).not.toBeNull();
  }
  for (const command of [
    'echo rm -rf "$BUILD/*"',
    "cat file",
    "rm -rf /tmp/build",
    '# rm -rf "$BUILD/*"',
  ]) {
    expect(f.run(() => n.FOe(command))).toBeNull();
  }
});
test("native assignment tracker distinguishes named, empty, root-valued and derived values", () => {
  const f = owner();
  const n = f.literal.native;
  const named = f.run(() =>
    n.aat('BUILD=./build; rm -rf "$BUILD/*"', () => true),
  );
  expect([...named.set]).toEqual(["BUILD"]);
  expect([...named.rootValued]).toEqual([]);
  const empty = f.run(() => n.aat('BUILD=; rm -rf "$BUILD/*"', () => false));
  expect(empty.emptied.has("BUILD")).toBe(true);
  const root = f.run(() => n.aat('BUILD=/; rm -rf "$BUILD/*"', () => false));
  expect(root.rootValued.has("BUILD")).toBe(true);
  const derived = f.run(() =>
    n.aat('BUILD=$(pwd); rm -rf "$BUILD/*"', () => true),
  );
  expect(derived.derived.get("BUILD")).toEqual({
    value: "$(pwd)",
    becomes: "prints the current directory",
  });
  const candidate = f.run(() =>
    n.FOe('BUILD=$(pwd); rm -rf "$BUILD/*"', { mayBeUnset: () => true }),
  );
  expect(candidate?.derived?.becomes).toBe("prints the current directory");
  if (candidate === null) throw new Error("Missing derived candidate");
  const result = n.LOe(candidate, false);
  if (result.decisionReason?.type === "safetyCheck")
    expect(result.decisionReason.removalRule).toBe("derived_var");
  else throw new Error("Missing derived removal reason");
  expect(result.message).toContain("not empty");
});
test("skipAssignedOriginalHits remains a distinct source pass instead of ignoring all assignments", () => {
  const f = owner();
  const n = f.literal.native;
  const text = 'BUILD=./build; rm -rf "$BUILD/*"';
  const original = f.run(() => n.FOe(text, { mayBeUnset: () => true }));
  expect(original?.assigned).toBe(true);
  expect(
    f.run(() =>
      n.FOe(text, { mayBeUnset: () => true, skipAssignedOriginalHits: true }),
    ),
  ).toBeNull();
  const emptied = f.run(() =>
    n.FOe('BUILD=; rm -rf "$BUILD/*"', {
      mayBeUnset: () => false,
      skipAssignedOriginalHits: true,
    }),
  );
  expect(emptied).not.toBeNull();
});
test("source quote placeholder encoding round trips only its bounded native range", () => {
  const n = owner().literal.native;
  const text = 'rm "a b; (x)" \\ file';
  const encoded = n.CPr(text);
  expect(encoded).not.toBe(text);
  expect(n.uat(encoded)).toBe(text);
  expect(n.DOe("'open", 5)).toBe("'");
  expect(n.DOe('"closed"', 8)).toBeNull();
  expect(n.Zrt(["rm", "\n$BUILD/*\t"])).toBe("rm $BUILD/* ");
});
test("source shell assignment scanning handles unset events and masks heredoc bodies", () => {
  const f = owner();
  const n = f.literal.native;
  const cleared = f.run(() =>
    n.aat('BUILD=./safe; unset BUILD; rm -rf "$BUILD/*"', () => false),
  );
  expect(cleared.set.has("BUILD")).toBe(false);
  expect(cleared.emptied.has("BUILD")).toBe(true);
  const body = "cat <<'EOF'\nBUILD=/\nEOF\nBUILD=./safe; rm -rf \"$BUILD/*\"";
  const result = f.run(() => n.aat(body, () => true));
  expect(result.set.has("BUILD")).toBe(true);
  expect(result.rootValued.has("BUILD")).toBe(false);
});
