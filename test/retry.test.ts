import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions } from "../src/options.js";
import { AnthropicProvider } from "../src/provider.js";
import { retryDelay, retryableStatus } from "../src/retry.js";

test("retry backoff follows positive jitter and caps its exponential component", () => {
  const none = new Headers();
  assert.equal(
    retryDelay(1, none, () => 0),
    500,
  );
  assert.equal(
    retryDelay(2, none, () => 0),
    1000,
  );
  assert.equal(
    retryDelay(7, none, () => 0),
    32000,
  );
  assert.equal(
    retryDelay(15, none, () => 1),
    40000,
  );
  assert.equal(
    retryDelay(1, none, () => 0.5),
    563,
  );
});

test("retry delay honors milliseconds, seconds and HTTP dates without retrying earlier", () => {
  const now = Date.UTC(2026, 10, 17, 0, 0, 0);
  assert.equal(
    retryDelay(
      1,
      new Headers({ "retry-after-ms": "1200", "retry-after": "3" }),
      () => 0,
      now,
    ),
    1200,
  );
  assert.equal(
    retryDelay(1, new Headers({ "retry-after": "1.5" }), () => 0, now),
    1500,
  );
  assert.equal(
    retryDelay(
      1,
      new Headers({ "retry-after": new Date(now + 5000).toUTCString() }),
      () => 0,
      now,
    ),
    5000,
  );
  assert.equal(
    retryDelay(1, new Headers({ "retry-after-ms": "2000" }), () => 0.5, now),
    2250,
  );
  for (const after of [
    "",
    "-1",
    "Infinity",
    "nonsense",
    new Date(now - 1000).toUTCString(),
  ]) {
    assert.equal(
      retryDelay(1, new Headers({ "retry-after": after }), () => 0, now),
      500,
    );
  }
  assert.equal(
    retryDelay(
      1,
      new Headers({ "retry-after-ms": "-9", "retry-after": "2" }),
      () => 0,
      now,
    ),
    2000,
  );
});

test("retry eligibility respects hard refusal hints and excludes redirects", () => {
  for (const status of [408, 409, 429, 500, 503, 529, 599]) {
    assert.equal(retryableStatus(status, new Headers()), true);
    assert.equal(
      retryableStatus(status, new Headers({ "x-should-retry": "false" })),
      false,
    );
  }
  for (const status of [200, 307, 400, 401, 403, 404, 413, 418, 451])
    assert.equal(retryableStatus(status, new Headers()), false);
  assert.equal(
    retryableStatus(418, new Headers({ "x-should-retry": "true" })),
    true,
  );
  assert.equal(
    retryableStatus(307, new Headers({ "x-should-retry": "true" })),
    false,
  );
});

test("retry budgets are explicit bounded launch settings, including disabling retries", () => {
  assert.equal(parseOptions([]).maxRetries, 10);
  for (const value of [0, 1, 15]) {
    assert.equal(
      parseOptions(["--max-retries", String(value)]).maxRetries,
      value,
    );
    assert.doesNotThrow(
      () => new AnthropicProvider({ apiKey: "local", maxRetries: value }),
    );
  }
  for (const value of [-1, 0.5, 16, NaN, Infinity]) {
    assert.throws(() => parseOptions(["--max-retries", String(value)]));
    assert.throws(
      () => new AnthropicProvider({ apiKey: "local", maxRetries: value }),
      /maxRetries/,
    );
  }
});
