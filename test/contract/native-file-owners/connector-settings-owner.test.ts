import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  createNativeConnectorSettingsOwner,
  nativeSettingsConnectorSpelling,
  type NativeConnectorSettingsContext,
  type NativeConnectorSettingsReaders,
} from "../../../src/native-file-owners/connector-settings-owner.js";
import { nativeLocalPermissionPathFilesystem } from "../../../src/native-path-inspection.js";
import type {
  NativePermissionFact,
  NativePermissionScope,
} from "../../../src/native-permission-outcome.js";
import type { NativeProfileIo } from "../../../src/native-file-owners/account-path-owner.js";

function owned(
  run: (input: {
    root: string;
    work: string;
    directory: string;
    context: NativeConnectorSettingsContext;
    readers: NativeConnectorSettingsReaders;
    scope: NativePermissionScope;
    calls: string[];
    fact: <T>(value: T) => NativePermissionFact<T>;
  }) => void,
) {
  const root = realpathSync(
    mkdtempSync(posix.join(tmpdir(), "tau-connector-settings-")),
  );
  const work = posix.join(root, "work");
  const directory = posix.join(work, "connector-downloads");
  mkdirSync(directory, { recursive: true });
  const scope = { policyId: "owned-connector-epoch", cwd: work };
  const context: NativeConnectorSettingsContext = {
    pathContext: {
      cwd: work,
      home: posix.join(root, "home"),
      initialCwd: work,
      filesystem: nativeLocalPermissionPathFilesystem,
      macos: true,
    },
    configHome: posix.join(root, "config"),
    homeIsAutomount: false,
  };
  const calls: string[] = [];
  const fact = <T>(value: T): NativePermissionFact<T> => ({
    status: "known",
    value,
    provenance: {
      provider: "owned-connector-data",
      sourceContracts: ["owned-marker-fixture"],
      scope,
    },
  });
  function io<T>(
    path: string,
    operation: () => T,
  ): NativePermissionFact<NativeProfileIo<T>> {
    assert.ok(
      path === root || path.startsWith(root + "/"),
      "Only owned marker data may be read",
    );
    calls.push(path);
    try {
      return fact({ kind: "value", value: operation() });
    } catch (error) {
      return fact({
        kind: "error",
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined,
      });
    }
  }
  const readers: NativeConnectorSettingsReaders = {
    context: () => fact(context),
    readdir: (path) =>
      io(path, () =>
        readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
        })),
      ),
    lstatFile: (path) =>
      io(path, () => {
        const stat = lstatSync(path);
        return { isFile: stat.isFile(), size: stat.size };
      }),
    readMarkerNoFollow: (path, maxBytes) =>
      io(path, () => {
        const descriptor = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const data = Buffer.alloc(maxBytes);
          const count = readSync(descriptor, data, 0, data.length, 0);
          return data.subarray(0, count).toString("utf8");
        } finally {
          closeSync(descriptor);
        }
      }),
  };
  try {
    run({ root, work, directory, context, readers, scope, calls, fact });
  } finally {
    rmSync(root, { recursive: true });
  }
}
function known<T>(fact: NativePermissionFact<T>): T {
  if (fact.status !== "known") assert.fail(fact.reason);
  return fact.value;
}

test("native connector listing marker precedes absent .gitignore result", () =>
  owned(({ directory, readers, scope }) => {
    writeFileSync(posix.join(directory, "download-1234abcd.txt"), "authored");
    assert.equal(
      known(
        createNativeConnectorSettingsOwner(readers).inside(
          posix.join(directory, "child"),
          scope,
        ),
      ),
      true,
    );
  }));

test("connector marker reads accept exactly star, star LF and star CRLF", () =>
  owned(({ directory, readers, scope }) => {
    for (const text of [
      "*",
      "*\n",
      "*\r\n",
      "**",
      "* ",
      "*\n\n",
      "long marker",
    ]) {
      writeFileSync(posix.join(directory, ".gitignore"), text);
      assert.equal(
        known(
          createNativeConnectorSettingsOwner(readers).inside(directory, scope),
        ),
        ["*", "*\n", "*\r\n"].includes(text),
        JSON.stringify(text),
      );
    }
  }));

test("missing marker is inactive but complete cached result persists until exact clear", () =>
  owned(({ directory, readers, scope, calls }) => {
    const owner = createNativeConnectorSettingsOwner(readers);
    assert.equal(known(owner.inside(directory, scope)), false);
    const observed = calls.length;
    writeFileSync(posix.join(directory, ".gitignore"), "*");
    assert.equal(known(owner.inside(directory, scope)), false);
    assert.equal(calls.length, observed);
    owner.clear();
    assert.equal(known(owner.inside(directory, scope)), true);
  }));

test("unavailable factual readers stay unsupported while actual I/O error activates source suppression", () =>
  owned(({ directory, readers, scope, fact }) => {
    const missing = createNativeConnectorSettingsOwner({
      ...readers,
      readdir: () => ({
        status: "unsupported",
        dependency: "actual-connector-listing",
        reason: "No admitted directory listing",
      }),
    }).inside(directory, scope);
    assert.equal(missing.status, "unsupported");
    if (missing.status === "unsupported")
      assert.equal(missing.dependency, "actual-connector-listing");
    const error = createNativeConnectorSettingsOwner({
      ...readers,
      readdir: () => fact({ kind: "error", code: "EACCES" }),
    }).inside(directory, scope);
    assert.equal(known(error), true);
  }));

test("ordinary marker symlink stays nonregular while network-target marker refusal is source-positive", () =>
  owned(({ root, directory, context, readers, scope }) => {
    const target = posix.join(root, "marker.txt");
    writeFileSync(target, "*");
    const marker = posix.join(directory, ".gitignore");
    symlinkSync(target, marker);
    assert.equal(
      known(
        createNativeConnectorSettingsOwner(readers).inside(directory, scope),
      ),
      false,
    );
    const probes: string[] = [];
    const filesystem = context.pathContext.filesystem;
    context.pathContext = {
      ...context.pathContext,
      filesystem: {
        ...filesystem,
        lstat(path) {
          probes.push(path);
          return path === marker
            ? { isSymbolicLink: () => true }
            : filesystem.lstat(path);
        },
        readlink: () => "/net/foreign/private-marker",
      },
    };
    assert.equal(
      known(
        createNativeConnectorSettingsOwner(readers).inside(directory, scope),
      ),
      true,
    );
    assert.ok(!probes.some((path) => path.startsWith("/net/foreign")));
  }));

test("negative tilde-containing classifier result is not retained", () =>
  owned(({ work, readers, scope }) => {
    const directory = posix.join(work, "user~", "connector-downloads");
    mkdirSync(directory, { recursive: true });
    const owner = createNativeConnectorSettingsOwner(readers);
    assert.equal(known(owner.inside(directory, scope)), false);
    writeFileSync(posix.join(directory, ".gitignore"), "*");
    assert.equal(known(owner.inside(directory, scope)), true);
  }));

test("source builtin and exact config-project namespace need no marker discovery", () =>
  owned(({ context, readers, scope, calls }) => {
    const owner = createNativeConnectorSettingsOwner(readers);
    assert.equal(
      known(owner.inside("/mnt/user-data/connector-downloads/file", scope)),
      true,
    );
    const config = context.configHome;
    assert.notEqual(config, null);
    if (config === null) assert.fail("Owned config root is known");
    const project = posix.join(
      config,
      "projects",
      "named.1234567890abcdef",
      "connector-downloads",
      "file",
    );
    assert.equal(known(owner.inside(project, scope)), true);
    assert.deepEqual(calls, []);
  }));

test("connector spelling preserves source Ga folding and last-component exclusion", () => {
  assert.equal(
    nativeSettingsConnectorSpelling("/root/connector-downloads"),
    false,
  );
  assert.equal(
    nativeSettingsConnectorSpelling(
      "/root/CONNEC\u200cTOR-DOWNLOADS. :stream/file",
    ),
    true,
  );
  assert.equal(
    nativeSettingsConnectorSpelling("/root/connector-downloads-extra/file"),
    false,
  );
});
