import assert from "node:assert/strict";
import { mock, spyOn, test } from "bun:test";

const clock = { now: () => "real" };
const callback = mock(() => "called");
const home = process.env.TAU_HOME;
const config = process.env.CLAUDE_CONFIG_DIR;

// Both tests check for pristine state and then leak every kind of change, so
// whichever runs second proves the first one's changes were undone, in any order.
function assertPristineThenLeak() {
  assert.equal(clock.now(), "real");
  assert.equal(callback.mock.calls.length, 0);
  assert.equal(process.env.TAU_HYGIENE_PROBE, undefined);
  assert.equal(process.env.TAU_HOME, home);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, config);

  spyOn(clock, "now").mockReturnValue("patched");
  callback();
  process.env.TAU_HYGIENE_PROBE = "added";
  process.env.TAU_HOME = "changed";
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(clock.now(), "patched");
}

test(
  "a spy, a mock call and env edits made in one test",
  assertPristineThenLeak,
);
test("are gone by the next test", assertPristineThenLeak);
