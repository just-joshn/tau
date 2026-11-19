import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { composeFileManagedParentSettings } from "./managed-parent.js";

export type SettingsSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "flagSettings"
  | "policySettings";
export const SETTINGS_SOURCE_ORDER: readonly SettingsSource[] = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
];
export const SETTINGS_MAX_BYTES = 2 * 1024 * 1024;
export type JsonValue =
  string | number | boolean | null | JsonValue[] | SettingsRecord;
export interface SettingsRecord {
  [key: string]: JsonValue;
}
export interface ConfigurationDiagnostic {
  path?: string;
  source?: SettingsSource;
  reason: string;
  message: string;
}
export type PathReadPolicy = (
  path: string,
  canonicalPath?: string,
) => boolean | string | Promise<boolean | string>;
export type TextReadResult =
  | { status: "loaded"; text: string; canonicalPath: string }
  | {
      status: "absent" | "withheld" | "unreadable";
      reason: string;
      message: string;
    };

/** A bounded regular-file read. Roots and policy are supplied by the caller; no personal state is discovered. */
export async function readBoundedConfigurationText(
  path: string,
  maxBytes: number,
  policy?: PathReadPolicy,
): Promise<TextReadResult> {
  if (!isAbsolute(path))
    throw new Error("Configuration paths must be absolute");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Invalid configuration byte limit");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await policy?.(path);
    if (initial === false || typeof initial === "string")
      return {
        status: "withheld",
        reason: "policy",
        message:
          typeof initial === "string"
            ? initial
            : "Read policy withheld this file",
      };
    const canonicalPath = await realpath(path);
    const decision = await policy?.(path, canonicalPath);
    if (decision === false || typeof decision === "string")
      return {
        status: "withheld",
        reason: "policy",
        message:
          typeof decision === "string"
            ? decision
            : "Read policy withheld this file",
      };
    handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (!before.isFile())
      return {
        status: "withheld",
        reason: "special-file",
        message: "Configuration input must be a regular file",
      };
    if (before.size > maxBytes)
      return {
        status: "withheld",
        reason: "oversize",
        message: `Configuration input exceeds ${maxBytes} bytes`,
      };
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        bytes,
      );
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes)
      return {
        status: "withheld",
        reason: "oversize",
        message: `Configuration input exceeds ${maxBytes} bytes`,
      };
    const after = await handle.stat();
    const landed = await lstat(canonicalPath);
    if (
      !landed.isFile() ||
      landed.dev !== before.dev ||
      landed.ino !== before.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      (await realpath(path)) !== canonicalPath
    ) {
      return {
        status: "withheld",
        reason: "changed-during-read",
        message: "Configuration input changed while being read",
      };
    }
    return {
      status: "loaded",
      text: buffer.subarray(0, bytes).toString("utf8"),
      canonicalPath,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT" || code === "ENOTDIR")
      return {
        status: "absent",
        reason: "absent",
        message: "Configuration input does not exist",
      };
    return {
      status: "unreadable",
      reason: "read-error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close();
  }
}

export interface SettingsOrigin {
  source: SettingsSource;
  path?: string;
}
export interface SettingsDocument extends SettingsOrigin {
  status: "loaded" | "absent" | "withheld" | "unreadable" | "invalid";
  raw?: SettingsRecord;
  effective?: SettingsRecord;
  /** Generic JSON acceptance does not claim the original complete settings schema. */
  schemaValidated: boolean;
  diagnostics: ConfigurationDiagnostic[];
}
export interface SourcedPermissionRule extends SettingsOrigin {
  behavior: "allow" | "deny" | "ask";
  rule: string;
}
export type SettingsInput =
  { path: string; inline?: never } | { inline: unknown; path?: never };
export interface ConfigurationOptions {
  cwd: string;
  userConfigDir?: string;
  projectConfigDir?: string;
  /** Already resolved by the caller's git ownership/host policy; omitted means cwd. */
  localStoreRoot?: string;
  legacyLocalRoot?: string;
  managedRoot?: string;
  /** Precomposed policy input(s); mutually exclusive with managedRoot. No MDM/helper behavior is guessed. */
  policy?: SettingsInput | readonly SettingsInput[];
  /** Parent launch policy is projected and admitted separately from administrator files. */
  parent?: SettingsInput;
  flag?: SettingsInput | readonly SettingsInput[];
  allowedSources?: string | readonly ("user" | "project" | "local")[];
  /** Explicit workspace decisions; absence never supplies personal trust state. */
  permissionTrust: { projectAllows: boolean; localAllows: boolean };
  readPolicy?: PathReadPolicy;
  /** Complete/custom schema can be injected without discarding unrecognized keys in the generic resolver. */
  validate?: (
    value: SettingsRecord,
    origin: SettingsOrigin,
  ) => SettingsRecord | Promise<SettingsRecord>;
  /** Host launch-folder and credential-key restrictions belong here, before merging. */
  filterSource?: (
    value: SettingsRecord,
    origin: SettingsOrigin,
  ) => SettingsRecord | Promise<SettingsRecord>;
}
export interface ConfigurationSnapshot {
  enabledSources: readonly SettingsSource[];
  documents: readonly SettingsDocument[];
  effective: SettingsRecord;
  /** Composed managed policy, before ordinary settings are merged into it. */
  policy: SettingsRecord;
  permissionRules: readonly SourcedPermissionRule[];
  diagnostics: readonly ConfigurationDiagnostic[];
  limitations: readonly string[];
  /** All contributing documents by key, not an inaccurate scalar-only winner map. */
  provenance: Readonly<Record<string, readonly SettingsOrigin[]>>;
  roots: {
    cwd: string;
    project: string;
    local: string;
    user?: string;
    managed?: string;
    legacyLocal?: string;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function set(object: SettingsRecord, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
function jsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (typeof value !== "object" || value === null || seen.has(value))
    throw new Error("Settings must contain finite JSON values without cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      return items.map((item) => jsonValue(item, seen));
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Settings must contain plain JSON objects");
    const result: SettingsRecord = {};
    const entries: [string, unknown][] = Object.entries(value);
    for (const [key, item] of entries) set(result, key, jsonValue(item, seen));
    return result;
  } finally {
    seen.delete(value);
  }
}
export function validateJsonSettings(value: unknown): SettingsRecord {
  if (!record(value))
    throw new Error("Settings document must be a JSON object");
  const result = jsonValue(value);
  if (!object(result))
    throw new Error("Settings document must be a JSON object");
  return result;
}
function clone(value: JsonValue): JsonValue {
  return jsonValue(value);
}
function object(value: JsonValue | undefined): value is SettingsRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mergeValue(
  earlier: JsonValue | undefined,
  later: JsonValue,
  key: string,
): JsonValue {
  if (key === "modelPicker") return clone(later);
  if (Array.isArray(earlier) && Array.isArray(later))
    return key === "fallbackModel"
      ? clone(later)
      : [...new Set([...earlier, ...later])].map(clone);
  if (object(earlier) && object(later)) {
    const result = validateJsonSettings(earlier);
    for (const [name, value] of Object.entries(later)) {
      const previous = Object.hasOwn(earlier, name) ? earlier[name] : undefined;
      set(
        result,
        name,
        key === "managedMcpServers" || key === "extraKnownMarketplaces"
          ? clone(value)
          : mergeValue(previous, value, name),
      );
    }
    return result;
  }
  return clone(later);
}
/** Source A5: recursive objects, additive Set-deduped arrays, and explicit replacement nodes. */
export function mergeSettings(
  earlier: SettingsRecord,
  later: SettingsRecord,
): SettingsRecord {
  const merged = mergeValue(earlier, later, "");
  if (!object(merged))
    throw new Error("Settings document must be a JSON object");
  return merged;
}
export function enabledSettingsSources(
  input?: ConfigurationOptions["allowedSources"],
): SettingsSource[] {
  const labels =
    input === undefined
      ? ["user", "project", "local"]
      : typeof input === "string"
        ? input === ""
          ? []
          : input.split(",").map((part) => part.trim())
        : input;
  const names = {
    user: "userSettings",
    project: "projectSettings",
    local: "localSettings",
  } as const;
  const allowed = new Set<SettingsSource>(["flagSettings", "policySettings"]);
  const isLabel = (label: string): label is keyof typeof names =>
    Object.hasOwn(names, label);
  for (const label of labels) {
    if (!isLabel(label))
      throw new Error(
        `Invalid setting source: ${label}. Valid options are: user, project, local`,
      );
    allowed.add(names[label]);
  }
  return SETTINGS_SOURCE_ORDER.filter((source) => allowed.has(source));
}
function absolute(path: string): string {
  if (!isAbsolute(path))
    throw new Error(`Configuration root must be absolute: ${path}`);
  return resolve(path).normalize("NFC");
}
const isInputList = (
  input: SettingsInput | readonly SettingsInput[],
): input is readonly SettingsInput[] => Array.isArray(input);
function inputs(
  input: SettingsInput | readonly SettingsInput[] | undefined,
): readonly SettingsInput[] {
  return input === undefined ? [] : isInputList(input) ? input : [input];
}

export async function resolveConfiguration(
  options: ConfigurationOptions,
): Promise<ConfigurationSnapshot> {
  if (options.managedRoot !== undefined && options.policy !== undefined)
    throw new Error("Supply managedRoot or precomposed policy, not both");
  const roots: ConfigurationSnapshot["roots"] = {
    cwd: absolute(options.cwd),
    project: absolute(options.projectConfigDir ?? options.cwd),
    local: absolute(options.localStoreRoot ?? options.cwd),
    ...(options.userConfigDir !== undefined
      ? { user: absolute(options.userConfigDir) }
      : {}),
    ...(options.managedRoot !== undefined
      ? { managed: absolute(options.managedRoot) }
      : {}),
    ...(options.legacyLocalRoot !== undefined
      ? { legacyLocal: absolute(options.legacyLocalRoot) }
      : {}),
  };
  const enabledSources = enabledSettingsSources(options.allowedSources);
  const documents: SettingsDocument[] = [],
    diagnostics: ConfigurationDiagnostic[] = [];
  const provenance: Record<string, SettingsOrigin[]> = {};
  const seenPaths = new Set<string>();
  let effective: SettingsRecord = {},
    policyEffective: SettingsRecord = {};
  const sourceValues = new Map<SettingsSource, SettingsRecord>();
  function note(
    value: SettingsRecord,
    origin: SettingsOrigin,
    prefix = "",
  ): void {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      const list =
        (Object.hasOwn(provenance, name) ? provenance[name] : undefined) ?? [];
      Object.defineProperty(provenance, name, {
        value: [...list, origin],
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (object(item)) note(item, origin, name);
    }
  }
  async function load(
    source: SettingsSource,
    input: SettingsInput,
  ): Promise<void> {
    const path =
      input.path !== undefined ? resolve(roots.cwd, input.path) : undefined;
    if (path !== undefined) {
      if (seenPaths.has(path)) return;
      seenPaths.add(path);
    }
    const origin: SettingsOrigin = {
      source,
      ...(path !== undefined ? { path } : {}),
    };
    const document: SettingsDocument = {
      ...origin,
      status: "loaded",
      schemaValidated: options.validate !== undefined,
      diagnostics: [],
    };
    documents.push(document);
    try {
      let raw: unknown;
      if (path !== undefined) {
        const read = await readBoundedConfigurationText(
          path,
          SETTINGS_MAX_BYTES,
          options.readPolicy,
        );
        if (read.status !== "loaded") {
          document.status = read.status;
          if (read.status !== "absent")
            document.diagnostics.push({
              ...origin,
              reason: read.reason,
              message: read.message,
            });
          return;
        }
        raw =
          read.text.trim() === ""
            ? {}
            : JSON.parse(read.text.replace(/^\uFEFF/, ""));
      } else raw = input.inline;
      document.raw = validateJsonSettings(raw);
      let value = options.validate
        ? validateJsonSettings(await options.validate(document.raw, origin))
        : document.raw;
      if (options.filterSource)
        value = validateJsonSettings(await options.filterSource(value, origin));
      document.effective = value;
      effective = mergeSettings(effective, value);
      const merged = mergeSettings(sourceValues.get(source) ?? {}, value);
      sourceValues.set(source, merged);
      if (source === "policySettings") policyEffective = merged;
      note(value, origin);
    } catch (error) {
      document.status = "invalid";
      document.diagnostics.push({
        ...origin,
        reason: "invalid-settings",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      diagnostics.push(...document.diagnostics);
    }
  }
  for (const source of enabledSources) {
    if (source === "userSettings" && roots.user !== undefined)
      await load(source, { path: join(roots.user, "settings.json") });
    if (source === "projectSettings")
      await load(source, {
        path: join(roots.project, ".claude", "settings.json"),
      });
    if (source === "localSettings") {
      if (roots.legacyLocal !== undefined && roots.legacyLocal !== roots.local)
        await load(source, {
          path: join(roots.legacyLocal, ".claude", "settings.local.json"),
        });
      await load(source, {
        path: join(roots.local, ".claude", "settings.local.json"),
      });
    }
    if (source === "flagSettings")
      for (const input of inputs(options.flag)) await load(source, input);
    if (source === "policySettings") {
      if (roots.managed !== undefined) {
        await load(source, {
          path: join(roots.managed, "managed-settings.json"),
        });
        const directory = join(roots.managed, "managed-settings.d");
        try {
          const decision = await options.readPolicy?.(directory);
          if (decision === false || typeof decision === "string")
            diagnostics.push({
              source,
              path: directory,
              reason: "policy",
              message:
                typeof decision === "string"
                  ? decision
                  : "Read policy withheld managed settings directory",
            });
          else
            for (const entry of (
              await readdir(directory, { withFileTypes: true })
            )
              .filter(
                (entry) =>
                  !entry.name.startsWith(".") &&
                  entry.name.endsWith(".json") &&
                  (entry.isFile() || entry.isSymbolicLink()),
              )
              .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
              await load(source, { path: join(directory, entry.name) });
        } catch (error) {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
          ))
            diagnostics.push({
              source,
              path: directory,
              reason: "read-error",
              message: error instanceof Error ? error.message : String(error),
            });
        }
      } else
        for (const input of inputs(options.policy)) await load(source, input);
      if (options.parent !== undefined) {
        const administrator = policyEffective;
        const beforeParent = documents.length;
        await load(source, options.parent);
        const parentDocument = documents[beforeParent];
        if (parentDocument?.status === "loaded" && parentDocument.effective) {
          const composition = composeFileManagedParentSettings(
            administrator,
            parentDocument.effective,
          );
          parentDocument.effective = composition.projectedParent;
          policyEffective = composition.settings;
        } else policyEffective = administrator;
        sourceValues.set(source, policyEffective);
        effective = SETTINGS_SOURCE_ORDER.reduce(
          (merged, name) => mergeSettings(merged, sourceValues.get(name) ?? {}),
          {},
        );
        // Recompute origin records after projection: ignored parent fields must
        // not appear to have contributed policy or permission grants.
        for (const key of Object.keys(provenance)) delete provenance[key];
        for (const document of documents)
          if (document.effective) note(document.effective, document);
      }
    }
  }
  for (const key of [
    "availableModels",
    "enforceAvailableModels",
    "modelPicker",
  ] as const)
    if (policyEffective[key] !== undefined)
      set(effective, key, clone(policyEffective[key]));
  if (policyEffective.deniedModels !== undefined)
    set(effective, "deniedModels", clone(policyEffective.deniedModels));
  else delete effective.deniedModels;
  const policyOnly = policyEffective.allowManagedPermissionRulesOnly === true;
  const permissionRules: SourcedPermissionRule[] = [];
  for (const source of enabledSources) {
    const value = sourceValues.get(source);
    if (!value || (policyOnly && source !== "policySettings")) continue;
    const permissions = value.permissions;
    if (!object(permissions)) continue;
    for (const behavior of ["allow", "deny", "ask"] as const) {
      const rules = permissions[behavior];
      if (rules === undefined) continue;
      if (
        !Array.isArray(rules) ||
        !rules.every((rule) => typeof rule === "string")
      ) {
        diagnostics.push({
          source,
          reason: "invalid-permissions",
          message: `permissions.${behavior} must be an array of strings`,
        });
        continue;
      }
      if (
        behavior === "allow" &&
        ((source === "projectSettings" &&
          !options.permissionTrust.projectAllows) ||
          (source === "localSettings" && !options.permissionTrust.localAllows))
      )
        continue;
      for (const rule of rules) {
        const origin = documents.find((document) => {
          const permissions = document.effective?.permissions;
          return (
            document.source === source &&
            object(permissions) &&
            Array.isArray(permissions[behavior]) &&
            permissions[behavior].includes(rule)
          );
        });
        permissionRules.push({
          source,
          ...(origin?.path !== undefined ? { path: origin.path } : {}),
          behavior,
          rule,
        });
      }
    }
  }
  const limitations = [
    ...(!options.validate
      ? [
          "Generic JSON validation only; the complete original settings schema must be supplied by the caller",
        ]
      : []),
    ...(!options.filterSource
      ? ["Host launch-folder and credential-key filtering was not supplied"]
      : []),
    ...(roots.managed !== undefined
      ? [
          "Filesystem managed documents only; remote/MDM/helper composition and malformed-policy restrictive substitutes are not reconstructed",
        ]
      : []),
  ];
  return {
    enabledSources,
    documents,
    effective,
    policy: validateJsonSettings(policyEffective),
    permissionRules,
    diagnostics,
    provenance,
    roots,
    limitations,
  };
}
