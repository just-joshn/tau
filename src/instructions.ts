import { lstat, readdir, realpath } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { Lexer, type Token } from "marked";
import { parse as parseYaml } from "yaml";
import picomatch from "picomatch";
import ignore from "ignore";
import {
  readBoundedConfigurationText,
  type PathReadPolicy,
} from "./configuration.js";

export const INSTRUCTION_MAX_BYTES = 4 * 1024 * 1024;
export const INSTRUCTION_IMPORT_DEPTH = 5;
export type InstructionKind = "Managed" | "User" | "Project" | "Local";
export interface InstructionFile {
  path: string;
  canonicalPath: string;
  kind: InstructionKind;
  content: string;
  parent?: string;
  globs?: readonly string[];
  isRule?: boolean;
  contentDiffersFromDisk: boolean;
  rawContent?: string;
}
export interface InstructionIssue {
  path: string;
  kind: InstructionKind;
  reason: string;
  message: string;
}
export interface InstructionUpdate {
  files: InstructionFile[];
  withheld: InstructionIssue[];
  diagnostics: InstructionIssue[];
}
export interface ExternalInstructionImport {
  path: string;
  parent: string;
  kind: InstructionKind;
}
export type InstructionReadPolicy = (
  path: string,
  canonicalPath?: string,
  kind?: InstructionKind,
) => ReturnType<PathReadPolicy>;
export interface InstructionOptions {
  cwd: string;
  userConfigDir?: string;
  /** Explicit expansion root for ~/ imports; never inferred from config home or process state. */
  importHome?: string;
  managedRoot?: string;
  sources: { user: boolean; project: boolean; local: boolean };
  /** An explicit caller restriction. Default ancestor walk ends before filesystem root. */
  ancestorBoundary?: string;
  skipDirectory?: (path: string) => boolean;
  additionalDirectories?: readonly string[];
  loadAdditionalDirectoryInstructions?: boolean;
  managedInstructionsOnly?: boolean;
  disabled?: boolean;
  managedInline?: readonly { path: string; content: string }[];
  externalIncludesApproved?: boolean;
  /** User instructions normally allow external imports; local-agent mode narrows this. */
  localAgent?: boolean;
  approveExternalImport?: (
    request: ExternalInstructionImport,
  ) => boolean | Promise<boolean>;
  readPolicy?: InstructionReadPolicy;
  excludePatterns?: readonly string[];
}
const TEXT_EXTENSIONS = new Set(
  ".md .txt .text .json .yaml .yml .toml .xml .csv .html .htm .css .scss .sass .less .js .ts .tsx .jsx .mjs .cjs .mts .cts .py .pyi .pyw .rb .erb .rake .go .rs .java .kt .kts .scala .c .cpp .cc .cxx .h .hpp .hxx .cs .swift .sh .bash .zsh .fish .ps1 .bat .cmd .env .ini .cfg .conf .config .properties .sql .graphql .gql .proto .vue .svelte .astro .ejs .hbs .pug .jade .php .pl .pm .lua .r .dart .ex .exs .erl .hrl .clj .cljs .cljc .edn .hs .lhs .elm .ml .mli .f .f90 .f95 .for .cmake .make .makefile .gradle .sbt .rst .adoc .asciidoc .org .tex .latex .lock .log .diff .patch".split(
    " ",
  ),
);
function absolute(path: string): string {
  if (!isAbsolute(path))
    throw new Error(`Instruction root must be absolute: ${path}`);
  return resolve(path);
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}
function unsafe(path: string): boolean {
  return (
    /^(?:\\\\|\/\/)/.test(path) ||
    ["/dev", "/proc", "/sys"].some(
      (root) => path === root || path.startsWith(`${root}/`),
    )
  );
}
function slash(path: string): string {
  return path.replaceAll("\\", "/");
}
function entries(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(entries);
  if (typeof value !== "string") return [];
  const result: string[] = [];
  let depth = 0,
    current = "";
  for (const character of value) {
    if (character === "{") depth++;
    if (character === "}") depth--;
    if (character === "," && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}
/** Original paths grammar splits comma lists outside braces and bounds simple brace expansion. */
function ruleGlobs(value: unknown): string[] {
  const patterns = entries(value),
    result: string[] = [];
  let remainingResults = 1000,
    remainingBytes = INSTRUCTION_MAX_BYTES;
  for (const pattern of patterns) {
    if (!pattern.includes("{")) {
      result.push(pattern);
      continue;
    }
    const pending = [pattern],
      expanded: string[] = [];
    let exceeded = false;
    for (
      let current = pending.pop();
      current !== undefined;
      current = pending.pop()
    ) {
      const [, head, body, tail] =
        /^([^{]*)\{([^}]+)\}(.*)$/.exec(current) ?? [];
      if (head === undefined || body === undefined || tail === undefined) {
        expanded.push(current);
        continue;
      }
      const alternatives = body.split(",").map((part) => part.trim());
      remainingBytes -= current.length;
      const count = expanded.length + pending.length + alternatives.length;
      if (
        remainingBytes < 0 ||
        count > remainingResults ||
        count * pattern.length > remainingBytes
      ) {
        exceeded = true;
        break;
      }
      for (const alternative of alternatives.toReversed())
        pending.push(head + alternative + tail);
    }
    if (exceeded) result.push(pattern);
    else {
      remainingResults -= expanded.length;
      remainingBytes -= expanded.length * pattern.length;
      result.push(...expanded);
    }
  }
  return result
    .map((pattern) =>
      pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern,
    )
    .filter(Boolean);
}
interface ParsedInstructions {
  content: string;
  globs?: string[];
  imports: string[];
  parseError?: string;
}
/** Marked token traversal keeps code spans, fenced blocks and comments out of import discovery. */
export function parseInstructionText(
  text: string,
  path: string,
  tildeHome?: string,
): ParsedInstructions {
  let content = text,
    paths: unknown,
    parseError: string | undefined;
  const match = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(
    text.replace(/^\uFEFF/, ""),
  );
  if (match) {
    content = text.replace(/^\uFEFF/, "").slice(match[0].length);
    try {
      const frontmatter: unknown = parseYaml(match[1] ?? "");
      if (
        typeof frontmatter === "object" &&
        frontmatter !== null &&
        !Array.isArray(frontmatter)
      )
        paths = "paths" in frontmatter ? frontmatter.paths : undefined;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }
  const globs = ruleGlobs(paths);
  const tokens = Lexer.lex(content);
  const stripped = tokens
    .map((token) =>
      token.type === "html" &&
      token.raw.trimStart().startsWith("<!--") &&
      token.raw.includes("-->")
        ? token.raw.replace(/<!--[\s\S]*?-->/g, "")
        : token.raw,
    )
    .join("");
  const imports = new Set<string>();
  function collect(text: string): void {
    const expression = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
    for (const match of text.matchAll(expression)) {
      let target = match[1]?.split("#", 1)[0]?.replaceAll("\\ ", " ");
      if (
        !target ||
        target === "/" ||
        target.startsWith("@") ||
        /^[#%^&*()]+$/.test(target)
      )
        continue;
      if (!(
        target.startsWith("./") ||
        target.startsWith("~/") ||
        target.startsWith("/") ||
        /^[a-zA-Z0-9._-]/.test(target)
      ))
        continue;
      if (target.startsWith("~/")) {
        // Expansion is explicit; process homedir is never read by this module.
        if (tildeHome === undefined) continue;
        target = join(tildeHome, target.slice(2));
      }
      imports.add(resolve(dirname(path), target));
    }
  }
  function walk(tokens: readonly Token[]): void {
    for (const token of tokens) {
      if (token.type === "code" || token.type === "codespan") continue;
      if (token.type === "html") {
        if (
          token.raw.trimStart().startsWith("<!--") &&
          token.raw.includes("-->")
        ) {
          const remainder = token.raw.replace(/<!--[\s\S]*?-->/g, "");
          if (remainder.trim()) collect(remainder);
        }
        continue;
      }
      if (token.type === "text" && typeof token.text === "string")
        collect(token.text);
      if ("tokens" in token && Array.isArray(token.tokens)) walk(token.tokens);
      if ("items" in token && Array.isArray(token.items)) walk(token.items);
    }
  }
  walk(tokens);
  return {
    content: stripped,
    imports: [...imports],
    ...(globs.length && !globs.every((pattern) => pattern === "**")
      ? { globs }
      : {}),
    ...(parseError !== undefined ? { parseError } : {}),
  };
}

export class InstructionCatalog {
  private readonly cwd: string;
  private readonly user?: string;
  private readonly managed?: string;
  private readonly ancestors: readonly string[];
  private readonly loaded = new Map<string, InstructionFile>();
  private initialLoaded = false;
  private readonly matchesExcluded: (path: string) => boolean;
  constructor(private readonly options: InstructionOptions) {
    this.cwd = absolute(options.cwd);
    if (options.userConfigDir !== undefined)
      this.user = absolute(options.userConfigDir);
    if (options.managedRoot !== undefined)
      this.managed = absolute(options.managedRoot);
    if (options.importHome !== undefined) absolute(options.importHome);
    if (
      options.ancestorBoundary !== undefined &&
      !within(absolute(options.ancestorBoundary), this.cwd)
    )
      throw new Error("Instruction ancestor boundary must contain cwd");
    const directories: string[] = [],
      boundary =
        options.ancestorBoundary === undefined
          ? undefined
          : absolute(options.ancestorBoundary);
    for (
      let directory = this.cwd;
      directory !== parse(directory).root;
      directory = dirname(directory)
    ) {
      if (!options.skipDirectory?.(directory)) directories.unshift(directory);
      if (directory === boundary) break;
    }
    this.ancestors = directories;
    this.matchesExcluded = options.excludePatterns?.length
      ? picomatch(options.excludePatterns.map(slash), { dot: true })
      : () => false;
  }
  get files(): readonly InstructionFile[] {
    return [...this.loaded.values()];
  }
  readonly limitations = [
    "Raw instruction catalog; original model-dependent display/injection trimming belongs to the caller",
    "Host/worktree/automount exclusions and path permissions must be supplied explicitly",
    "Complete native path identity and canonical exclusion-prefix behavior is not reconstructed",
  ] as const;
  private update(): InstructionUpdate {
    return { files: [], withheld: [], diagnostics: [] };
  }
  private issue(
    update: InstructionUpdate,
    path: string,
    kind: InstructionKind,
    reason: string,
    message: string,
  ): void {
    update.withheld.push({ path, kind, reason, message });
  }
  private admit(
    files: readonly InstructionFile[],
    update: InstructionUpdate,
  ): void {
    for (const file of files)
      if (
        !this.loaded.has(file.canonicalPath) &&
        (!this.options.managedInstructionsOnly || file.kind === "Managed")
      ) {
        this.loaded.set(file.canonicalPath, file);
        update.files.push(file);
      }
  }
  private async tree(
    path: string,
    kind: InstructionKind,
    seen: Set<string>,
    external: boolean,
    update: InstructionUpdate,
    depth = 0,
    parent?: string,
  ): Promise<InstructionFile[]> {
    if (depth >= INSTRUCTION_IMPORT_DEPTH) {
      this.issue(
        update,
        path,
        kind,
        "import-depth",
        "Instruction import depth limit reached",
      );
      return [];
    }
    if (kind !== "Managed" && this.matchesExcluded(slash(path))) {
      this.issue(
        update,
        path,
        kind,
        "excluded",
        "Instruction file is excluded",
      );
      return [];
    }
    if (unsafe(path)) {
      this.issue(
        update,
        path,
        kind,
        "unsafe-path",
        "Device, process and network instruction paths require an external path policy",
      );
      return [];
    }
    const extension = extname(path).toLowerCase();
    if (extension && !TEXT_EXTENSIONS.has(extension)) {
      this.issue(
        update,
        path,
        kind,
        "non-text",
        "Instruction import has an unsupported text extension",
      );
      return [];
    }
    let refusal: { reason: string; message: string } | undefined;
    const approved = new Set<string>();
    const read = await readBoundedConfigurationText(
      path,
      INSTRUCTION_MAX_BYTES,
      async (spelling, canonicalPath) => {
        const candidate = canonicalPath ?? spelling;
        const decision = await this.options.readPolicy?.(
          spelling,
          canonicalPath,
          kind,
        );
        if (decision === false || typeof decision === "string") return decision;
        if (unsafe(candidate)) {
          refusal = {
            reason: "unsafe-path",
            message: "Instruction file resolves to an unsupported path",
          };
          return refusal.message;
        }
        if (kind !== "Managed" && this.matchesExcluded(slash(candidate))) {
          refusal = {
            reason: "excluded",
            message: "Canonical instruction path is excluded",
          };
          return refusal.message;
        }
        if (
          parent &&
          !within(this.cwd, candidate) &&
          !external &&
          !approved.has(candidate)
        ) {
          if (
            await this.options.approveExternalImport?.({
              path: candidate,
              parent,
              kind,
            })
          )
            approved.add(candidate);
          else {
            refusal = {
              reason: "external-import",
              message: "External instruction import has not been approved",
            };
            return refusal.message;
          }
        }
        if (
          canonicalPath !== undefined &&
          kind === "User" &&
          this.options.localAgent &&
          !external
        ) {
          const stat = await lstat(spelling);
          if (
            (depth === 0 && stat.isSymbolicLink()) ||
            (stat.isFile() && stat.nlink > 1)
          ) {
            refusal = {
              reason: "local-agent-link",
              message: "Local-agent user instructions cannot use this link",
            };
            return refusal.message;
          }
        }
        return true;
      },
    );
    if (read.status !== "loaded") {
      if (read.status !== "absent")
        this.issue(
          update,
          path,
          kind,
          refusal?.reason ?? read.reason,
          refusal?.message ?? read.message,
        );
      return [];
    }
    if (seen.has(read.canonicalPath)) return [];
    seen.add(read.canonicalPath);
    const parsed = parseInstructionText(
      read.text,
      read.canonicalPath,
      this.options.importHome,
    );
    if (parsed.parseError)
      update.diagnostics.push({
        path,
        kind,
        reason: "frontmatter",
        message: parsed.parseError,
      });
    if (!parsed.content.trim()) return [];
    const differs = parsed.content !== read.text;
    const file: InstructionFile = {
      path,
      canonicalPath: read.canonicalPath,
      kind,
      content: parsed.content,
      contentDiffersFromDisk: differs,
      ...(differs ? { rawContent: read.text } : {}),
      ...(parent !== undefined ? { parent } : {}),
      ...(parsed.globs !== undefined ? { globs: parsed.globs } : {}),
    };
    const files = [file];
    for (const imported of parsed.imports)
      files.push(
        ...(await this.tree(
          imported,
          kind,
          seen,
          external,
          update,
          depth + 1,
          path,
        )),
      );
    return files;
  }
  private async rules(
    directory: string,
    kind: InstructionKind,
    seen: Set<string>,
    external: boolean,
    update: InstructionUpdate,
    conditionalPath?: string,
    root = directory,
    visited = new Set<string>(),
  ): Promise<InstructionFile[]> {
    if (unsafe(directory)) {
      this.issue(
        update,
        directory,
        kind,
        "unsafe-path",
        "Unsupported rule directory path",
      );
      return [];
    }
    let canonical: string, listing: string[];
    try {
      const decision = await this.options.readPolicy?.(
        directory,
        undefined,
        kind,
      );
      if (decision === false || typeof decision === "string") {
        this.issue(
          update,
          directory,
          kind,
          "policy",
          typeof decision === "string"
            ? decision
            : "Read policy withheld rule directory",
        );
        return [];
      }
      canonical = await realpath(directory);
      const canonicalDecision = await this.options.readPolicy?.(
        directory,
        canonical,
        kind,
      );
      if (
        canonicalDecision === false ||
        typeof canonicalDecision === "string"
      ) {
        this.issue(
          update,
          directory,
          kind,
          "policy",
          typeof canonicalDecision === "string"
            ? canonicalDecision
            : "Read policy withheld rule directory",
        );
        return [];
      }
      if (unsafe(canonical)) {
        this.issue(
          update,
          directory,
          kind,
          "unsafe-path",
          "Rule directory resolves to an unsupported path",
        );
        return [];
      }
      if (visited.has(canonical)) return [];
      visited.add(canonical);
      if (
        (await lstat(directory)).isSymbolicLink() &&
        !within(this.cwd, canonical) &&
        !external
      ) {
        this.issue(
          update,
          directory,
          kind,
          "external-rule-directory",
          "External linked rule directory is not approved",
        );
        return [];
      }
      listing = await readdir(directory);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ))
        update.diagnostics.push({
          path: directory,
          kind,
          reason: "rules-walk",
          message: error instanceof Error ? error.message : String(error),
        });
      return [];
    }
    const result: InstructionFile[] = [];
    for (const name of listing) {
      const path = join(directory, name);
      try {
        const stat = await lstat(path);
        const canonicalPath = stat.isSymbolicLink()
          ? await realpath(path)
          : path;
        if (
          stat.isSymbolicLink() &&
          !within(this.cwd, canonicalPath) &&
          !external
        ) {
          this.issue(
            update,
            path,
            kind,
            "external-rule-link",
            "External linked rule entry is not approved",
          );
          continue;
        }
        if (
          stat.isDirectory() ||
          (stat.isSymbolicLink() && (await lstat(canonicalPath)).isDirectory())
        )
          result.push(
            ...(await this.rules(
              path,
              kind,
              seen,
              external,
              update,
              conditionalPath,
              root,
              visited,
            )),
          );
        else if (name.endsWith(".md")) {
          const files = await this.tree(path, kind, seen, external, update);
          if (files[0]) files[0].isRule = true;
          for (const file of files) {
            if (
              conditionalPath === undefined
                ? file.globs === undefined
                : this.matchesRule(
                    file,
                    conditionalPath,
                    kind === "User" || kind === "Managed"
                      ? this.cwd
                      : dirname(dirname(root)),
                  )
            )
              result.push(file);
          }
        }
      } catch (error) {
        update.diagnostics.push({
          path,
          kind,
          reason: "rules-entry",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }
  private matchesRule(
    file: InstructionFile,
    target: string,
    root: string,
  ): boolean {
    const path = slash(relative(root, target));
    if (
      !file.globs?.length ||
      !path ||
      path.startsWith("../") ||
      isAbsolute(path)
    )
      return false;
    return ignore()
      .add([...file.globs])
      .ignores(path);
  }
  async loadInitial(): Promise<InstructionUpdate> {
    const update = this.update();
    if (this.initialLoaded || this.options.disabled) return update;
    this.initialLoaded = true;
    const seen = new Set<string>(),
      external = this.options.externalIncludesApproved === true;
    if (this.managed !== undefined) {
      this.admit(
        await this.tree(
          join(this.managed, "CLAUDE.md"),
          "Managed",
          seen,
          external,
          update,
        ),
        update,
      );
      for (const inline of this.options.managedInline ?? [])
        if (inline.content.trim())
          this.admit(
            [
              {
                path: inline.path,
                canonicalPath: inline.path,
                kind: "Managed",
                content: inline.content,
                contentDiffersFromDisk: true,
                rawContent: inline.content,
              },
            ],
            update,
          );
      this.admit(
        await this.rules(
          join(this.managed, ".claude", "rules"),
          "Managed",
          seen,
          external,
          update,
        ),
        update,
      );
    } else
      for (const inline of this.options.managedInline ?? [])
        if (inline.content.trim())
          this.admit(
            [
              {
                path: inline.path,
                canonicalPath: inline.path,
                kind: "Managed",
                content: inline.content,
                contentDiffersFromDisk: true,
                rawContent: inline.content,
              },
            ],
            update,
          );
    if (
      !this.options.managedInstructionsOnly &&
      this.options.sources.user &&
      this.user !== undefined
    ) {
      this.admit(
        await this.tree(
          join(this.user, "CLAUDE.md"),
          "User",
          seen,
          !this.options.localAgent,
          update,
        ),
        update,
      );
      this.admit(
        await this.rules(
          join(this.user, "rules"),
          "User",
          seen,
          !this.options.localAgent,
          update,
        ),
        update,
      );
    }
    if (!this.options.managedInstructionsOnly)
      for (const directory of [
        ...this.ancestors,
        ...(this.options.loadAdditionalDirectoryInstructions
          ? (this.options.additionalDirectories?.map(absolute) ?? [])
          : []),
      ]) {
        if (this.options.sources.project) {
          for (const path of [
            join(directory, "CLAUDE.md"),
            join(directory, ".claude", "CLAUDE.md"),
          ])
            this.admit(
              await this.tree(path, "Project", seen, external, update),
              update,
            );
          this.admit(
            await this.rules(
              join(directory, ".claude", "rules"),
              "Project",
              seen,
              external,
              update,
            ),
            update,
          );
        }
        if (this.options.sources.local)
          this.admit(
            await this.tree(
              join(directory, "CLAUDE.local.md"),
              "Local",
              seen,
              external,
              update,
            ),
            update,
          );
      }
    return update;
  }
  async loadForPath(path: string): Promise<InstructionUpdate> {
    const update = this.update(),
      target = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
    if (this.options.disabled || !within(this.cwd, target)) return update;
    const permitted = await this.options.readPolicy?.(
      target,
      undefined,
      "Project",
    );
    if (permitted === false || typeof permitted === "string") return update;
    const seen = new Set<string>();
    if (this.managed !== undefined)
      this.admit(
        await this.rules(
          join(this.managed, ".claude", "rules"),
          "Managed",
          seen,
          false,
          update,
          target,
        ),
        update,
      );
    if (
      !this.options.managedInstructionsOnly &&
      this.options.sources.user &&
      this.user !== undefined
    )
      this.admit(
        await this.rules(
          join(this.user, "rules"),
          "User",
          seen,
          !this.options.localAgent,
          update,
          target,
        ),
        update,
      );
    if (this.options.managedInstructionsOnly) return update;
    const nested: string[] = [];
    for (
      let directory = dirname(target);
      within(this.cwd, directory) && directory !== this.cwd;
      directory = dirname(directory)
    )
      if (!this.options.skipDirectory?.(directory)) nested.unshift(directory);
    for (const directory of nested) {
      if (this.options.sources.project) {
        for (const file of [
          join(directory, "CLAUDE.md"),
          join(directory, ".claude", "CLAUDE.md"),
        ])
          this.admit(
            await this.tree(file, "Project", seen, false, update),
            update,
          );
        const unconditionalSeen = new Set(seen);
        this.admit(
          await this.rules(
            join(directory, ".claude", "rules"),
            "Project",
            unconditionalSeen,
            false,
            update,
          ),
          update,
        );
        this.admit(
          await this.rules(
            join(directory, ".claude", "rules"),
            "Project",
            seen,
            false,
            update,
            target,
          ),
          update,
        );
        for (const path of unconditionalSeen) seen.add(path);
      }
      if (this.options.sources.local)
        this.admit(
          await this.tree(
            join(directory, "CLAUDE.local.md"),
            "Local",
            seen,
            false,
            update,
          ),
          update,
        );
    }
    if (this.options.sources.project)
      for (const directory of this.ancestors)
        this.admit(
          await this.rules(
            join(directory, ".claude", "rules"),
            "Project",
            seen,
            false,
            update,
            target,
          ),
          update,
        );
    return update;
  }
}
export function createInstructionCatalog(
  options: InstructionOptions,
): InstructionCatalog {
  return new InstructionCatalog(options);
}
