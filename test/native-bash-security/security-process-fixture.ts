import { createOuterFixture } from "./outer-fixture.js";
import {
  createNativeBashSecurityProcess,
  type NativeBashSecurityProcessHosts,
} from "../../src/native-bash-security/security-process.js";
import { NativeBashSecurityUnsupported } from "../../src/native-bash-security/security-types.js";
import { known, policy } from "./security-fixture.js";
import type {
  NativeBashSecurityInput as Input,
  NativeBashSecurityPolicy as Policy,
} from "../../src/native-bash-security/security-types.js";
/** Test facts shared with the existing authored fixtures, never production defaults. */
export function createSecurityProcessFixture() {
  const f = createOuterFixture();
  const currentCwd = f.recurse.host.currentCwd;
  const livePolicy = f.outerHost.livePolicy;
  if (!currentCwd || !livePolicy)
    throw new Error("Missing authored actual getter");
  const hosts: NativeBashSecurityProcessHosts = {
    policy: f.policyHost,
    shapes: {
      strictInlineShellRemovalDisabled: (s) => known(false, s),
      paleKestrel: (s) => known(true, s),
      removalShapeEvent: (_shape, s) => known(undefined, s),
    },
    syntax: { wildOctopus: (s) => known(true, s) },
    inline: f.recurse.host,
    nested: f.nested.host,
    complexity: f.complex.host,
    state: f.stateHost,
    descendant: f.main.cwd.descendant.host,
    cwd: f.main.cwd.host,
    pipeline: { currentCwd, duplicatePipeReasons: (s) => known(true, s) },
    main: { ...f.main.host, currentCwd, livePolicy },
    alternates: f.alternates.host,
    primitives: f.primitives.host,
    outer: { ...f.outerHost, currentCwd },
  };
  // Explicit finite POSIX test facts for the reached source spelling primitives.
  // Windows/UNC conversion requires the separate hostname/network closure and stays unresolved.
  hosts.policy.pathPrimitive = (kind, value, scope) => {
    let result: string;
    switch (kind) {
      case "Vdo": {
        const normalized = value
          .replace(/(?!^)[\\/]+/g, "\\")
          .replace(/^[\\/]\?\?(?=[\\/])/, "\\\\?")
          .replace(/^[\\/]{2}[?.][\\/]UNC(?=[\\/])/i, "\\");
        result = value.startsWith("\\\\?\\")
          ? normalized
          : normalized.replace(
              /^([\\/]{2}[?.][\\/][a-z]:)[. ]+(?=[\\/]|$)/i,
              "$1",
            );
        break;
      }
      case "r7n":
        if (/^[\\/]{2}|^\\\?\?\\/.test(value))
          throw new NativeBashSecurityUnsupported(
            "authored.UNCProvider",
            "No UNC provider in this authored POSIX test",
          );
        result = value;
        break;
      case "Y4e": {
        const match =
          /^[\\/]{2}(?:[?.][\\/]([A-Za-z]):|(?:localhost|127\.0\.0\.1)[\\/]([A-Za-z])\$)(?=$|[\\/])/i.exec(
            value,
          );
        result =
          match === null
            ? value
            : `${match[1] ?? match[2]}:${value.slice(match[0].length) || "\\"}`;
        break;
      }
      case "Do":
        result = value
          .toLowerCase()
          .replace(/\u0131/g, "i")
          .replace(/\u017f/g, "s");
        break;
      case "y4": {
        let end = value.length;
        for (;;) {
          let spaces = end;
          while (spaces > 0 && value[spaces - 1] === " ") spaces--;
          const head = value.slice(0, spaces);
          if (head === "." || head === "..") {
            result = head;
            break;
          }
          let dots = spaces;
          while (dots > 0 && value[dots - 1] === ".") dots--;
          if (dots === end) {
            result = head;
            break;
          }
          end = dots;
        }
        break;
      }
      case "o7n":
        throw new NativeBashSecurityUnsupported(
          "authored.o7n",
          "No complete Windows normalization provider in this authored POSIX test",
        );
    }
    return known(result, scope);
  };
  const process = createNativeBashSecurityProcess(
    f.semantic,
    f.syntax.preparation,
    hosts,
  );
  function check(
    command: string,
    input: Partial<Input> = {},
    permission: Policy = policy(),
  ) {
    f.setOuterPolicy(permission);
    return process.check(
      { command, ...input },
      { policy: permission, cwd: "/work", context: f.outerContext() },
    );
  }
  return { ...f, process, hosts, check };
}
