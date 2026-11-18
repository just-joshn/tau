import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, lstatSync, openSync, closeSync, readSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, parse, resolve, sep } from "node:path";

export type LocalSettingsTracking = "untracked" | "tracked" | "tracked_in_index" | "indeterminate";
export interface LocalStoreOwnership { rootUid: number; gitEntryUid: number; claudeEntryUid: number | null }
export interface LocalStoreDecision { root: string; canonicalized: boolean; reason: "cwd" | "no-git-root" | "home-root" | "home-unavailable" | "ownership-verified" | "ownership-unavailable" | "ownership-mismatch" | "project-override" | "launch-override" }

/** SF/tns/aal: local consent storage canonicalizes only after a POSIX ownership check. */
export function selectLocalSettingsStoreRoot(options: {
  cwd: string; canonicalGitRoot: string | null; realHomeDirectory: string | null;
  effectiveUid: number | null; ownership?: LocalStoreOwnership;
}): LocalStoreDecision {
  const cwd = resolve(options.cwd), root = options.canonicalGitRoot === null ? null : resolve(options.canonicalGitRoot);
  const unchanged = (reason: LocalStoreDecision["reason"]): LocalStoreDecision => ({ root: cwd, canonicalized: false, reason });
  if (root === null) return unchanged("no-git-root");
  if (root === cwd) return unchanged("cwd");
  if (options.realHomeDirectory === null) return unchanged("home-unavailable");
  if (root === options.realHomeDirectory) return unchanged("home-root");
  if (options.effectiveUid === null || options.ownership === undefined) return unchanged("ownership-unavailable");
  const owner = options.ownership;
  if (owner.rootUid !== options.effectiveUid || owner.gitEntryUid !== options.effectiveUid || owner.claudeEntryUid !== null && owner.claudeEntryUid !== options.effectiveUid) return unchanged("ownership-mismatch");
  return { root, canonicalized: true, reason: "ownership-verified" };
}
const errorCode = (error: unknown): string | undefined => error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
const absent = (error: unknown): boolean => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
const key = (path: string): string => process.platform === "win32" ? normalize(path).replaceAll("\\", "/") : normalize(path);
const nfc = (path: string): string => path.normalize("NFC");
const real = (path: string): string | null => { try { return nfc(realpathSync(path)); } catch { return null; } };

/** Local POSIX path inspection; remote/automount paths require the host's separate classifier. */
function inspectable(path: string): boolean {
  if (path.includes("\0") || /^(?:\\\\|\/\/)/.test(path)) return false;
  try { lstatSync(path); return true; } catch (error) { return absent(error); }
}
function gitMarker(path: string): boolean {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      if (!inspectable(resolve(dirname(path), readlinkSync(path)))) return false;
      const target = statSync(path); return target.isDirectory() || target.isFile();
    }
    return entry.isDirectory() || entry.isFile();
  } catch { return false; }
}
function findGitRoot(cwd: string, excluded: ReadonlySet<string>): string | null {
  for (let directory = resolve(cwd);; directory = dirname(directory)) {
    if (!excluded.has(directory) && gitMarker(join(directory, ".git"))) return nfc(directory);
    if (directory === parse(directory).root) return null;
  }
}
function plainFile(path: string): boolean { try { return lstatSync(path).isFile(); } catch { return false; } }
function canonicalGitRoot(root: string): string {
  // Tt/qt: only the linked-worktree layout, including the reverse gitdir pointer,
  // changes identity. A submodule .git file does not canonicalize to its parent.
  try {
    const marker = readFileSync(join(root, ".git"), "utf8").trim();
    if (!marker.startsWith("gitdir:")) return root;
    const target = marker.slice(7).trim();
    if (!inspectable(resolve(root, target))) return root;
    const gitDir = resolve(root, target), commonPath = join(gitDir, "commondir"), backPath = join(gitDir, "gitdir");
    if (!plainFile(commonPath) || !plainFile(backPath)) return root;
    const common = resolve(gitDir, readFileSync(commonPath, "utf8").trim());
    if (resolve(dirname(gitDir)) !== join(common, "worktrees")) return root;
    const reverse = readFileSync(backPath, "utf8").trim();
    if (sep === "/" && [root, gitDir, common, reverse].some((value) => value.includes("\\"))) return root;
    if (real(resolve(gitDir, reverse)) !== join(real(root) ?? root, ".git")) return root;
    if (dirname(common) === common) return root;
    if (common.split(sep).at(-1) !== ".git") return gitMarker(join(common, ".git")) ? root : nfc(common);
    return nfc(dirname(common));
  } catch { return root; }
}
function ownership(root: string): LocalStoreOwnership | undefined {
  try {
    let claudeEntryUid: number | null = null;
    try { claudeEntryUid = lstatSync(join(root, ".claude")).uid; } catch (error) { if (!absent(error)) throw error; }
    return { rootUid: statSync(root).uid, gitEntryUid: lstatSync(join(root, ".git")).uid, claudeEntryUid };
  } catch { return undefined; }
}
function startsWithRoot(path: string, root: string): boolean { return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); }
function ancestorTrust(cwd: string, gitRoot: string | null, trusted: ReadonlySet<string>): boolean {
  for (let path = resolve(cwd);; path = dirname(path)) {
    if (gitRoot !== null && !startsWithRoot(path, gitRoot)) return false;
    if (trusted.has(key(nfc(path)))) return true;
    if (path === gitRoot || path === dirname(path)) return false;
  }
}
const gitArguments = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "safe.bareRepository=explicit", "-c", "protocol.file.allow=never"];
function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The local classifier needs no model/account credentials. Repository/index
  // overrides are deliberately absent, matching Ps's discovery isolation.
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SYSTEMROOT", "TMP", "TEMP", "TMPDIR", "XDG_CONFIG_HOME", "DEVELOPER_DIR"]) if (base[name] !== undefined) result[name] = base[name];
  return { ...result, GIT_LITERAL_PATHSPECS: "", GIT_TRACE2: "0", GIT_TRACE2_PERF: "0", GIT_TRACE2_EVENT: "0", GIT_ALLOW_PROTOCOL: "/", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_SSH_COMMAND: "false", GIT_CONFIG_PARAMETERS: "'alias.remote-none=version' 'alias.remote-none.command=version' 'alias.remote-/.command=version' 'fetch.bundleURI=' 'help.autocorrect=0'", LC_ALL: "C", LANGUAGE: "C" };
}
/** cU process-result table; an ENOENT launch differs from an unsafe/signal failure. */
export function classifyLocalSettingsGitProbe(result: Pick<SpawnSyncReturns<string>, "status" | "signal" | "error" | "stderr">): LocalSettingsTracking {
  if (result.error && absent(result.error)) return "untracked";
  if (result.signal !== null || result.error) return "tracked";
  if (result.status === 128) return /^fatal: not a git repository \(or any/.test(result.stderr ?? "") ? "indeterminate" : "tracked";
  if (result.status === 0) return "tracked_in_index";
  if (result.status === 1) return "untracked";
  return "tracked";
}
function readPrefix(path: string): string | null {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); const bytes = Buffer.alloc(255); return bytes.toString("latin1", 0, readSync(fd, bytes, 0, 255, 0)); }
  catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
function gitDirectory(path: string, strict: boolean): boolean {
  try {
    const head = join(path, "HEAD"), entry = lstatSync(head);
    if (entry.isSymbolicLink()) { if (!readlinkSync(head).startsWith("refs/")) return false; }
    else {
      const text = entry.isFile() ? readPrefix(head) : null;
      if (text === null || !(strict ? /^ref:[ \t\n\r]*refs\// : /^ref:\s*refs\//).test(text) && !/^[0-9a-fA-F]{40}/.test(text)) return false;
    }
    try { lstatSync(join(path, "commondir")); return !strict; } catch { /* objects/refs next */ }
    for (const name of ["objects", "refs"]) {
      const child = join(path, name);
      if (strict) { if (!statSync(child).isDirectory()) return false; accessSync(child, constants.X_OK); }
      else lstatSync(child);
    }
    return true;
  } catch { return false; }
}
const toleratedPathErrors = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG", "EINVAL"]);
function unresolvedSymlinkAncestor(path: string): boolean {
  for (let directory = resolve(path);; directory = dirname(directory)) {
    try { if (lstatSync(directory).isSymbolicLink()) return true; }
    catch (error) { if (!toleratedPathErrors.has(errorCode(error) ?? "")) return true; }
    if (directory === dirname(directory)) return false;
  }
}
function scanBareRepository(start: string, excluded: ReadonlySet<string>): boolean {
  let device: number | undefined;
  try { device = lstatSync(start).dev; } catch (error) { if (!toleratedPathErrors.has(errorCode(error) ?? "")) throw error; }
  for (let directory = start;; directory = dirname(directory)) {
    if (excluded.has(directory)) return true;
    try {
      const marker = join(directory, ".git"), entry = lstatSync(marker);
      if (entry.isSymbolicLink() && !inspectable(resolve(directory, readlinkSync(marker)))) return true;
      if (entry.isFile() || (entry.isSymbolicLink() ? statSync(marker).isDirectory() : entry.isDirectory()) && gitDirectory(marker, true)) return false;
    } catch (error) { if (!toleratedPathErrors.has(errorCode(error) ?? "")) throw error; }
    if (gitDirectory(directory, false)) return true;
    if (dirname(directory) === directory) return false;
    if (process.platform !== "win32" && device !== undefined) {
      try { if (lstatSync(dirname(directory)).dev !== device) return false; }
      catch (error) { if (!toleratedPathErrors.has(errorCode(error) ?? "")) throw error; return false; }
    }
  }
}
function bareOrUnsafeRepository(cwd: string, excluded: ReadonlySet<string>): boolean {
  const original = resolve(cwd), physical = real(cwd);
  if (physical === null && unresolvedSymlinkAncestor(original)) return true;
  try { return scanBareRepository(physical ?? original, excluded) || physical !== null && physical !== original && scanBareRepository(original, excluded); }
  catch { return true; }
}
export interface WorkspaceConfigurationOptions {
  cwd: string | null;
  configDirectory: string;
  homeDirectory?: string;
  projectConfigRoot?: string;
  launchLocalSettingsStoreRoot?: string;
  workspaceTrustAccepted?: boolean;
  trustedProjectKeys?: readonly string[];
  ignorePersistedTrust?: boolean;
  diskless?: boolean;
  gitExecutable?: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  excludedGitDirectories?: readonly string[];
}
export interface WorkspaceConfiguration {
  startupCwd: string | null;
  gitRoot: string | null;
  canonicalGitRoot: string | null;
  projectKey: string | null;
  userSettingsPath: string;
  projectSettingsPath?: string;
  localSettingsPath?: string;
  legacyLocalSettingsPath?: string;
  localStore?: LocalStoreDecision;
  localStoreOwnership?: LocalStoreOwnership;
  projectEqualsUserSettings: boolean;
  persistedWorkspaceTrusted: boolean;
  currentWorkspaceTrusted: boolean;
  /** Ordinary oP/C permission-source gates; managed-only restrictions apply separately. */
  projectPermissionAllowsAdmitted: boolean;
  localPermissionAllowsAdmitted: boolean;
  /** GL/hho candidate gate, distinct from the permission-source gate above. */
  localMcpApprovalTrusted: boolean;
  localTracking: { status: LocalSettingsTracking | "not-probed"; reason: string; checkedRoots: string[] };
}

/** Roots and GL/hho admission metadata, without filtering any permission settings. */
export async function inspectWorkspaceConfiguration(options: WorkspaceConfigurationOptions): Promise<WorkspaceConfiguration> {
  options.signal?.throwIfAborted();
  const cwd = options.cwd === null ? null : nfc(resolve(options.cwd));
  const configDirectory = nfc(resolve(options.configDirectory)), home = options.homeDirectory ?? homedir();
  const excluded = new Set((options.excludedGitDirectories ?? []).map((value) => resolve(value)));
  const gitRoot = cwd === null || options.diskless ? null : findGitRoot(cwd, excluded);
  const canonical = gitRoot === null ? null : canonicalGitRoot(gitRoot);
  const projectKey = cwd === null ? null : key(canonical ?? cwd);
  const trusted = new Set(options.ignorePersistedTrust ? [] : options.trustedProjectKeys ?? []);
  const persistedWorkspaceTrusted = projectKey !== null && trusted.has(projectKey);
  const currentWorkspaceTrusted = cwd !== null && (options.workspaceTrustAccepted === true || persistedWorkspaceTrusted || ancestorTrust(cwd, gitRoot, trusted));
  const result: WorkspaceConfiguration = {
    startupCwd: cwd, gitRoot, canonicalGitRoot: canonical, projectKey,
    userSettingsPath: join(configDirectory, "settings.json"), projectEqualsUserSettings: false,
    persistedWorkspaceTrusted, currentWorkspaceTrusted, projectPermissionAllowsAdmitted: false, localPermissionAllowsAdmitted: false, localMcpApprovalTrusted: false,
    localTracking: { status: "not-probed", reason: "no-workspace", checkedRoots: [] },
  };
  const projectRoot = options.projectConfigRoot === undefined ? cwd : resolve(options.projectConfigRoot);
  if (options.diskless || projectRoot === null) {
    result.localTracking.reason = options.diskless ? "diskless" : "no-workspace";
    return result;
  }
  const owner = canonical === null ? undefined : ownership(canonical);
  const decision = selectLocalSettingsStoreRoot({ cwd: projectRoot, canonicalGitRoot: canonical, realHomeDirectory: real(home), effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : typeof process.getuid === "function" ? process.getuid() : null, ...(owner === undefined ? {} : { ownership: owner }) });
  const root = options.launchLocalSettingsStoreRoot === undefined ? options.projectConfigRoot === undefined ? decision.root : projectRoot : resolve(options.launchLocalSettingsStoreRoot);
  result.localStore = options.launchLocalSettingsStoreRoot !== undefined ? { root, canonicalized: root !== projectRoot, reason: "launch-override" }
    : options.projectConfigRoot !== undefined ? { root, canonicalized: false, reason: "project-override" } : decision;
  if (owner !== undefined) result.localStoreOwnership = owner;
  result.projectSettingsPath = join(projectRoot, ".claude", "settings.json");
  result.localSettingsPath = join(root, ".claude", "settings.local.json");
  if (root !== projectRoot) result.legacyLocalSettingsPath = join(projectRoot, ".claude", "settings.local.json");
  result.projectEqualsUserSettings = resolve(result.projectSettingsPath) === resolve(result.userSettingsPath);
  result.projectPermissionAllowsAdmitted = persistedWorkspaceTrusted || result.projectEqualsUserSettings;
  result.localPermissionAllowsAdmitted = persistedWorkspaceTrusted;
  const userLocation = cwd !== null && (real(cwd) !== null && real(cwd) === real(home) || configDirectory === resolve(cwd, ".claude"));
  if (!currentWorkspaceTrusted) {
    result.localMcpApprovalTrusted = userLocation && options.projectConfigRoot === undefined && decision.root === cwd;
    result.localPermissionAllowsAdmitted ||= result.localMcpApprovalTrusted;
    result.localTracking.reason = result.localMcpApprovalTrusted ? "user-location-exception" : "workspace-untrusted";
    return result;
  }
  const checkedRoots = [...new Set([projectRoot, options.launchLocalSettingsStoreRoot ?? (options.projectConfigRoot === undefined ? decision.root : projectRoot)])];
  let status: LocalSettingsTracking = "untracked", reason = "git-untracked";
  for (const directory of checkedRoots) {
    let observed: LocalSettingsTracking = "untracked", observedReason = "git-untracked";
    if (real(directory) !== null && real(directory) === real(home) || configDirectory === resolve(directory, ".claude")) observedReason = "user-location-exception";
    else {
      let unsafe = false;
      for (const path of [join(directory, ".claude"), join(directory, ".claude", "settings.local.json"), join(directory, ".claude", ".git")]) {
        try { const entry = lstatSync(path); if (path.endsWith(`${sep}.git`) || entry.isSymbolicLink()) unsafe = true; }
        catch (error) { if (!absent(error)) unsafe = true; }
      }
      if (unsafe || bareOrUnsafeRepository(directory, excluded)) { observed = "tracked"; observedReason = "unsafe-local-path-or-repository"; }
      else if (options.gitExecutable === null) observedReason = "git-unavailable";
      else {
        const probe = spawnSync(options.gitExecutable ?? "git", [...gitArguments, "ls-files", "--error-unmatch", "--", ":(icase).claude/settings.local.json"], { cwd: directory, encoding: "utf8", timeout: 2000, windowsHide: true, env: gitEnvironment(options.env ?? process.env) });
        observed = classifyLocalSettingsGitProbe(probe);
        observedReason = `git-${observed}`;
      }
    }
    if (observed === "tracked_in_index") { status = observed; reason = observedReason; break; }
    if (observed === "tracked" || observed === "indeterminate" && status !== "tracked") { status = observed; reason = observedReason; }
  }
  options.signal?.throwIfAborted();
  result.localTracking = { status, reason, checkedRoots };
  result.localMcpApprovalTrusted = status === "untracked";
  result.localPermissionAllowsAdmitted ||= status === "untracked" || status === "indeterminate";
  return result;
}
