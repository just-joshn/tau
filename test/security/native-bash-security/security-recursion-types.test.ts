import { test, expect } from "bun:test";
import { nativeBashRemovalReviewConfig as config } from "../../../src/native-bash-security/security-recursion-types.js";
test("native removal config keeps its exact enabled/source asymmetry and default values", () => {
  expect(config({ value: undefined, source: "default" }, false)).toEqual({
    enabled: true,
    showDialog: true,
    denyOnHostCard: true,
    timeoutMs: 120000,
    maxDialogTimeouts: 3,
  });
  expect(
    config(
      {
        value: { enabled: false, showDialog: false, denyOnHostCard: false },
        source: "local",
      },
      false,
    ),
  ).toEqual({
    enabled: true,
    showDialog: false,
    denyOnHostCard: false,
    timeoutMs: 120000,
    maxDialogTimeouts: 3,
  });
  expect(
    config({ value: { enabled: false }, source: "payload" }, false).enabled,
  ).toBe(false);
  expect(
    config({ value: { enabled: true }, source: "payload" }, true).enabled,
  ).toBe(false);
  for (const payload of [null, 42, "disabled", [], { enabled: "false" }])
    expect(config({ value: payload, source: "payload" }, false).enabled).toBe(
      true,
    );
});
test("native removal timeout accepts finite fractions in range while dialog count requires integer bounds", () => {
  for (const timeoutMs of [5000, 5000.5, 3600000])
    expect(
      config({ value: { timeoutMs }, source: "payload" }, false).timeoutMs,
    ).toBe(timeoutMs);
  for (const timeoutMs of [4999, 3600001, NaN, Infinity, "5000"])
    expect(
      config({ value: { timeoutMs }, source: "payload" }, false).timeoutMs,
    ).toBe(120000);
  for (const maxDialogTimeouts of [0, 100, 7])
    expect(
      config({ value: { maxDialogTimeouts }, source: "payload" }, false)
        .maxDialogTimeouts,
    ).toBe(maxDialogTimeouts);
  for (const maxDialogTimeouts of [-1, 101, 0.5, NaN, "1"])
    expect(
      config({ value: { maxDialogTimeouts }, source: "payload" }, false)
        .maxDialogTimeouts,
    ).toBe(3);
});
test("native removal config preserves field getter order and skips enabled when the typed flag disables it", () => {
  const calls: string[] = [];
  const payload = {
    get enabled() {
      calls.push("enabled");
      return false;
    },
    get showDialog() {
      calls.push("showDialog");
      return false;
    },
    get denyOnHostCard() {
      calls.push("denyOnHostCard");
      return false;
    },
    get timeoutMs() {
      calls.push("timeoutMs");
      return 5000;
    },
    get maxDialogTimeouts() {
      calls.push("maxDialogTimeouts");
      return 0;
    },
  };
  config({ value: payload, source: "payload" }, true);
  expect(calls).toEqual([
    "showDialog",
    "showDialog",
    "denyOnHostCard",
    "denyOnHostCard",
    "timeoutMs",
    "timeoutMs",
    "timeoutMs",
    "timeoutMs",
    "timeoutMs",
    "maxDialogTimeouts",
    "maxDialogTimeouts",
    "maxDialogTimeouts",
    "maxDialogTimeouts",
    "maxDialogTimeouts",
  ]);
  calls.length = 0;
  config({ value: payload, source: "local" }, false);
  expect(calls[0]).toBe("enabled");
  expect(calls[1]).toBe("showDialog");
});
