import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  admitSessionPersistence,
  isInteractiveLaunch,
  NO_SESSION_PERSISTENCE_PRINT_ONLY,
} from "../../src/launch-mode.js";

test("a TTY launch without print tokens is interactive", () => {
  assert.equal(isInteractiveLaunch(["prompt"], true), true);
});

test("exact -p, --print, --init-only and a --sdk-url prefix are non-interactive on a TTY", () => {
  for (const argv of [
    ["-p"],
    ["--print"],
    ["x", "-p"],
    ["--init-only"],
    ["--sdk-url"],
    ["--sdk-url=http://127.0.0.1"],
  ])
    assert.equal(isInteractiveLaunch(argv, true), false, argv.join(" "));
});

test("piped stdout is non-interactive without any token", () => {
  assert.equal(isInteractiveLaunch([], false), false);
});

test("tokens after -- and near-miss spellings do not count", () => {
  for (const argv of [
    ["--", "-p"],
    ["--", "--sdk-url"],
    ["--print=true"],
    ["-pp"],
  ])
    assert.equal(isInteractiveLaunch(argv, true), true, argv.join(" "));
});

test("absent flag never disables persistence, in either mode", () => {
  for (const interactive of [true, false])
    assert.deepEqual(admitSessionPersistence(false, interactive), {
      ok: true,
      sessionPersistenceDisabled: false,
    });
});

test("the flag disables persistence non-interactively and is refused interactively", () => {
  assert.deepEqual(admitSessionPersistence(true, false), {
    ok: true,
    sessionPersistenceDisabled: true,
  });
  assert.deepEqual(admitSessionPersistence(true, true), {
    ok: false,
    error: NO_SESSION_PERSISTENCE_PRINT_ONLY,
  });
});
