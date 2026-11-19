import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import {
  createNativeBashSecurityPathControl,
  type NativeBashSecurityPathHost,
} from "../../../src/native-bash-security/path-control.js";
import { createNativeBashSecurityGitStructure } from "../../../src/native-bash-security/git-structure.js";
import { fixture, policy, known } from "./security-fixture.js";
export function gitFixture() {
  const f = fixture();
  let lstatCalls = 0;
  const preparation = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const host: NativeBashSecurityPathHost = {
    ...f.host,
    originalWorkingDirectory: (s) => known("/work", s),
  };
  host.filesystem.realpathSpelling = (path, s) => known(path, s);
  host.filesystem.lstat = (_path, s) => {
    lstatCalls++;
    return known(
      { status: "stat", isSymbolicLink: false, isDirectory: false },
      s,
    );
  };
  const path = createNativeBashSecurityPathControl(
    f.semantic,
    preparation,
    host,
  );
  const git = createNativeBashSecurityGitStructure(
    f.semantic,
    preparation,
    path,
    host,
  );
  async function writes(command: string) {
    const r = await f.semantic.analyze(command);
    if (r.kind !== "simple") throw new Error(r.reason);
    return git.withPolicyScope(policy(), "/work", () =>
      git.native.qOe(r.commands, "/work"),
    );
  }
  return { ...f, host, git, writes, lstatCalls: () => lstatCalls };
}
