import { expect, test } from "bun:test";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import type {
  NativePermissionScope as Scope,
  NativePermissionFact as Fact,
} from "../../../src/native-permission-outcome.js";
import { createNativeBashReadonlyProfiles } from "../../../src/native-bash-security/readonly-profiles.js";
import { policy } from "./security-fixture.js";

function known<T>(value: T, scope: Scope): Fact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "authored-readonly-profile",
      sourceContracts: ["YSn"],
      scope,
    },
  };
}

// Each row is [command, whether the profile admits it as read-only].
// `featureOn` answers the host's safe-feature gates by key.
function expectReadonly(
  rows: readonly (readonly [string, boolean])[],
  featureOn: (key: string) => boolean = () => true,
) {
  const f = createSecurityProcessFixture();
  const profiles = createNativeBashReadonlyProfiles(f.process, {
    safeFeature: (key, _safe, scope) => known(featureOn(key), scope),
  });
  for (const [command, readonly] of rows)
    expect({
      command,
      readonly: profiles.withPolicyScope(policy(), "/work", () =>
        profiles.native.rMr(command),
      ).result,
    }).toEqual({ command, readonly });
}

test("docker logs and inspect refuse daemon-selecting options anywhere in their operands", () => {
  expectReadonly([
    ["docker inspect --format '{{json .}}' container", true],
    ["docker logs --tail=10 container", true],
    ["docker logs -- --host=tcp://evil container", false],
    ["docker inspect -- -Hunix:///other.sock container", false],
    ["docker inspect -- -tc ctx container", false],
    ["docker logs container ~/out", false],
    ["docker logs container 'a{~}'", false],
    ["docker logs -- __CMDSUB_OUTPUT__", false],
  ]);
});

test("man reads only manual pages, never paths or apropos patterns that look like options", () => {
  expectReadonly([
    ["man ls", true],
    ["man -a ls", true],
    ["man -s 3 printf", true],
    ["man -S 2:3 open", true],
    ["man -- ls", true],
    ["man -k printf", true],
    ["man --apropos printf", true],
    ["man -f ls", true],
    ["man -kw printf", true],
    // getopt hands -S=2 the section list "=2", which is not a plain list.
    ["man -S=2 open", false],
    ["man -S ../section page", false],
    ["man ./local.1", false],
    ["man 'dir\\page'", false],
    ["man ~/page.1", false],
    ["man -k -- -x", false],
    ["man -- __CMDSUB_OUTPUT__", false],
  ]);
});

test("help never names a file path", () => {
  expectReadonly([
    ["help cd", true],
    ["help -d cd", true],
    ["help ./x", false],
    ["help 'a\\b'", false],
    ["help ~", false],
    ["help __TRACKED_VAR__", false],
  ]);
});

test("ps refuses BSD environment output and -e combined with extra formatting", () => {
  expectReadonly([
    ["ps aux", true],
    ["ps -ef", true],
    ["ps -eH", true],
    ["ps -e --forest", true],
    ["ps -- aux", true],
    ["ps auxe", false],
    ["ps ewww", false],
    ["ps -e --sort=pid", false],
    ["ps -eHL", false],
  ]);
});

test("date may only print, never set, the clock", () => {
  expectReadonly([
    ["date", true],
    ["date +%Y", true],
    ["date -u +%s", true],
    ["date -d tomorrow +%s", true],
    ["date --date=now", true],
    ["date -r file", true],
    ["date --rfc-3339 date", true],
    ["date --iso-8601=seconds", true],
    ["date 0101", false],
    ["date -u 0101", false],
  ]);
});

test("which accepts plain options and refuses a dash operand or expansion marker", () => {
  expectReadonly([
    ["which -a ls", true],
    ["which --skip-alias ls", true],
    ["which -- -x", true],
    ["which -", false],
    ["which -a=x", false],
    ["which -- __CMDSUB_OUTPUT__", false],
  ]);
});

test("lsof refuses mount supplements, host-name lookups and tilde paths", () => {
  expectReadonly([
    ["lsof -i tcp:22", true],
    ["lsof -i @10.0.0.1", true],
    ["lsof -i @10.0.0.1:22", true],
    ["lsof -p 123", true],
    ["lsof -i", true],
    ["lsof 12x", true],
    ["lsof +D /tmp", true],
    ["lsof +m", false],
    ["lsof +m/tmp/mounts", false],
    ["lsof -i @example.com", false],
    ["lsof -i @example.com:22", false],
    ["lsof -i ~/x", false],
    ["lsof -- -i@example.com", false],
    ["lsof -- -ni@example.com:22", false],
    // An option word carrying non-letters is refused while environment reads are refused.
    ["lsof -- -i@10.0.0.1", false],
    ["lsof -p1234", false],
    ["lsof +X", false],
    ["lsof -r 1m", false],
  ]);
});

test("tput refuses capabilities that reset or reprogram the terminal and stdin scripts", () => {
  expectReadonly([
    ["tput cols", true],
    ["tput -T xterm cols", true],
    ["tput -V", true],
    ["tput -x clear", false],
    ["tput reset", false],
    ["tput init", false],
    ["tput -- smcup", false],
    ["tput -S", false],
    ["tput -xS", false],
    ["tput -T=Sun cols", false],
  ]);
});

test("ss filters may not name hosts or services that need a lookup", () => {
  expectReadonly([
    ["ss -tlnp", true],
    ["ss -t state established", true],
    ["ss -f inet", true],
    ["ss dst 10.0.0.1", true],
    ["ss dst fe80::1", true],
    ["ss sport = :22", true],
    ["ss dst example.com", false],
    ["ss dst ab.cd", false],
    ["ss -- -x", false],
    ["ss ~", false],
  ]);
});

test("test refuses variable-name operands that bash evaluates", () => {
  expectReadonly([
    ["test -f file", true],
    ["test 1 -eq 2", true],
    ["test 0x1F -gt 2#101", true],
    ["test -t 1", true],
    ["test -- -f file", true],
    ["test -v name", false],
    ["test -R name", false],
    ["test -f a -a -f b", false],
    ["test -f a -o -f b", false],
    ["test 'x[0]' = y", false],
    ["test value -eq 1", false],
    ["test 1 -eq value", false],
    ["test -t fd", false],
  ]);
});

test("with its feature gate off, lsof admits unusual option words but still refuses mount supplements", () => {
  expectReadonly(
    [
      ["lsof -- -i@10.0.0.1", true],
      ["lsof +X", true],
      ["lsof +m", false],
      ["lsof -i @example.com", false],
    ],
    (key) => key !== "bot_protected_tengu_pewter_kettle",
  );
});

test("with its feature gate off, man admits an unusual section list", () => {
  expectReadonly(
    [
      ["man -S ../section page", true],
      ["man ./local.1", false],
    ],
    (key) => key !== "tengu_tender_thunder",
  );
});

test("with the dash-flag gate off, an undeclared punctuation word is an operand", () => {
  expectReadonly(
    [
      ["sort -. file", true],
      // A string value still may not begin with a dash.
      ["sort -k -. file", false],
    ],
    (key) => key !== "tengu_amber_thimble",
  );
});

test("hostname may print names but never set one", () => {
  expectReadonly([
    ["hostname", true],
    ["hostname -f", true],
    ["hostname --fqdn", true],
    ["hostname new-name", false],
  ]);
});
