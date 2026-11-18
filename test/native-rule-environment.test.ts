import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  nativeTypedEnvironmentBoolean,
  nativeTypedEnvironmentString,
  projectNativeTypedRuleEnvironment,
} from "../src/native-rule-environment.js";

test("actual N.bool parses affirmative raw values rather than nonempty-string truthiness", () => {
  for (const value of ["1", "true", "YES", " On \n"])
    assert.equal(nativeTypedEnvironmentBoolean(value), true, value);
  for (const value of [
    undefined,
    "",
    "0",
    "false",
    "no",
    "off",
    "enabled",
    "2",
    " ",
  ])
    assert.equal(
      nativeTypedEnvironmentBoolean(value),
      false,
      value ?? "actual absence",
    );
});

test("actual N.str trims only its typed consumer and turns empty strings into absence", () => {
  assert.equal(
    nativeTypedEnvironmentString(" \t/owned/host.json \n"),
    "/owned/host.json",
  );
  assert.equal(nativeTypedEnvironmentString(" \t\n"), undefined);
  assert.equal(nativeTypedEnvironmentString(undefined), undefined);
});

test("verified exact bool/string field domains project from explicitly owned raw inputs", () => {
  assert.deepEqual(
    projectNativeTypedRuleEnvironment({
      evalConfined: "true",
      projectsSession: "no",
      configProbe: "0",
      useCoworkPlugins: "on",
      hostCredentialsFile: " /owned/host.json ",
    }),
    {
      evalConfined: true,
      projectsSession: false,
      configProbe: false,
      useCoworkPlugins: true,
      hostCredentialsFile: "/owned/host.json",
    },
  );
});
