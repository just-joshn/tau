import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";
import type { NativeBashSyntaxNode as Node } from "../native-bash-parser.js";
import type { NativeBashSemanticCommand as Command } from "../native-bash-semantics.js";
import type { createNativeBashSecurityPolicyControl } from "./policy-control.js";
import type {
  NativeBashSecurityRemovalHistory as History,
  NativeBashSecurityNestedRemoval as Nested,
} from "./security-recursion-types.js";
import {
  needNativeBashSecurityCapability,
  readNativeBashSecurityFact,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityDecision as Decision,
} from "./security-types.js";

type PolicyOwner = ReturnType<typeof createNativeBashSecurityPolicyControl>;
export interface NativeBashSecurityRecursiveSyntaxHost {
  wildOctopus?: (scope: Scope) => Fact<boolean>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native recursive syntax invariant");
  return value;
}

/** Native tree transformations feed removal policy; their output is never a grant certificate. */
export function createNativeBashSecurityRecursiveSyntax(
  policy: PolicyOwner,
  host: NativeBashSecurityRecursiveSyntaxHost,
) {
  const path = policy.pathOwner;
  const { semantic, preparation } = path;
  const projection = preparation.projection;
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const { l1, sD, o2 } = path.native;
  const x5e = preparation.stripWrapperArgv;
  const rmt = () => preparation.features.appendEnvironmentNeedsReview();
  const V1 = semantic.parse;
  const _At = projection.hasErrorNode;
  const oR = semantic.analyze;
  const paths = path.gate.bindings.P() === "windows" ? win32 : posix;

  function jbn(
    text: string,
    rewrite: (argv: string[]) => string[],
    predicate: (argv: string[]) => boolean,
  ): boolean {
    const stripped = preparation.stripSimpleWrappers(text);
    const argv = projection.staticArgv(stripped);
    if (predicate(argv)) return true;
    const f = frame();
    if (
      !readNativeBashSecurityFact(
        needNativeBashSecurityCapability(
          host.wildOctopus,
          "features.wildOctopus",
        )(f.scope),
        f.scope,
        f.receipts,
      )
    )
      return false;
    const full =
      stripped === text
        ? argv
        : projection.staticArgv(
            text.replace(/^(?:time[ \t]+(?:--[ \t]+)?)+/, ""),
          );
    return predicate(rewrite(full));
  }
  function sb(text: string): boolean {
    return jbn(
      text,
      policy.native.Vat,
      ([name]) =>
        name === "cd" ||
        name === "pushd" ||
        name === "popd" ||
        name === "chdir",
    );
  }
  function O5e(text: string): boolean {
    return projection.splitCommands(text).some((part) => sb(part.trim()));
  }
  async function Lbn(
    text: string,
    expected: number,
  ): Promise<{ after: number; type: string }[] | null> {
    const tree = await V1(text);
    if (
      tree === null ||
      tree === semantic.parseAbort ||
      tree.type !== "program" ||
      _At(tree)
    )
      return null;
    const operators: { after: number; type: string }[] = [];
    let commands = 0;
    const operator = (node: Node) =>
      /^(?:&&|\|\||\||;|&|\|&|\n)$/.test(node.type);
    const visit = (node: Node): void => {
      if (operator(node))
        operators.push({ after: commands - 1, type: node.type });
      else if (node.type === "redirected_statement")
        node.children
          .filter((child) => !child.type.endsWith("_redirect"))
          .forEach(visit);
      else if (/^(?:program|list|pipeline)$/.test(node.type)) {
        let previous = false;
        for (const child of node.children.filter(
          (entry) => entry.type !== "comment",
        )) {
          if (previous && !operator(child))
            operators.push({ after: commands - 1, type: "\n" });
          visit(child);
          previous = !operator(child);
        }
      } else if (node.type !== "comment") commands++;
    };
    visit(tree);
    return commands === expected ? operators : null;
  }
  function $Or(text: string, commands: Command[]): History | undefined {
    const first = commands[0];
    if (first === undefined)
      return {
        text,
        cd: false,
        names: [...text.matchAll(/(?:^|\s)([A-Za-z_]\w*)\+?=/g)].map((match) =>
          required(match[1]),
        ),
        exports: false,
      };
    const [name = "", ...operands] = first.argv;
    if (commands.length > 1) return undefined;
    if (sb(first.text)) return { text, cd: true, names: [], exports: false };
    if (!/^(?:export|unset|declare|typeset|readonly|local)$/.test(name))
      return undefined;
    return {
      text,
      cd: false,
      names:
        name === "unset" &&
        operands.some((word) => /^-\w*f/.test(word)) &&
        !operands.some((word) => /^-\w*v/.test(word))
          ? []
          : operands
              .filter((word) => !word.startsWith("-"))
              .map((word) => {
                const key = word.replace(/=.*$/s, "");
                return key.endsWith("+") && rmt() ? key.slice(0, -1) : key;
              }),
      exports:
        name === "export" ||
        name === "unset" ||
        operands.some((word) => /^-\w*x/.test(word)),
    };
  }
  function MOr(
    node: Node,
  ): { whole: string; heads: [number, number][] } | undefined {
    if (node.type !== "redirected_statement" && node.type !== "command")
      return undefined;
    let command =
      node.type === "redirected_statement" ? node.children[0] : node;
    while (/^(?:list|pipeline|negated_command)$/.test(command?.type ?? ""))
      command = command?.children.at(-1);
    if (command?.type !== "command") return undefined;
    const words = command.children.filter(
      (child) =>
        child.type !== "variable_assignment" &&
        !child.type.endsWith("_redirect"),
    );
    const heads: [number, number][] = [];
    const argumentsAfterRedirect = [
      ...command.children,
      ...(node === command ? [] : node.children),
    ]
      .filter((child) => child.type === "file_redirect")
      .flatMap((child) => {
        const op = child.children.findIndex(
          (part) =>
            part.type !== "file_descriptor" && part.type !== "variable_name",
        );
        const after = child.children[op]?.type.endsWith("&-") ? op + 1 : op + 2;
        heads.push([
          child.startIndex,
          child.children[after - 1]?.endIndex ?? child.endIndex,
        ]);
        return child.children.slice(after);
      });
    return argumentsAfterRedirect.length > 0
      ? {
          whole: [...words, ...argumentsAfterRedirect]
            .sort((a, b) => a.startIndex - b.startIndex)
            .map((part) => part.text)
            .join(" "),
          heads: heads.filter(([start]) =>
            argumentsAfterRedirect.some((part) => start < part.startIndex),
          ),
        }
      : undefined;
  }
  function xbn(decision: Decision): Decision {
    return decision.behavior === "ask" &&
      decision.decisionReason?.type === "safetyCheck"
      ? {
          ...decision,
          decisionReason: {
            ...decision.decisionReason,
            removalRule: "emptyExpansion",
          },
        }
      : decision;
  }
  async function slt(
    node: Node,
    cwd: string,
    permission: Policy,
    forced = false,
    absoluteOnly = false,
  ): Promise<Nested[]> {
    const stack = [node];
    const edits: [number, number, string][] = [];
    let active = forced;
    for (
      let current = stack.pop();
      current !== undefined;
      current = stack.pop()
    ) {
      if (
        current.startIndex < node.startIndex ||
        current.endIndex > node.endIndex
      )
        continue;
      if (
        current.type === "file_redirect" ||
        (node.type === "command" &&
          /^(?:variable_assignment|\w+_redirect)$/.test(current.type))
      ) {
        active ||= current.text.includes("${HOME");
        edits.push([current.startIndex, current.endIndex, ""]);
      } else if (/^(?:command|process)_substitution$/.test(current.type))
        edits.push([current.startIndex, current.endIndex, "__CMDSUB__"]);
      else if (
        /^(?:expansion|ERROR)$/.test(current.type) &&
        /^\$\{HOME(?:\W[\s\S]*)?\}$/.test(current.text)
      ) {
        active = true;
        const prefix = /^\$\{HOME:?\+/.exec(current.text)?.[0].length;
        const bytes = Buffer.from(current.text);
        const nested = [...current.children];
        for (
          let child = nested.pop();
          child !== undefined;
          child = nested.pop()
        ) {
          if (/^(?:command|process)_substitution$/.test(child.type))
            bytes.fill(
              " ",
              child.startIndex - current.startIndex,
              child.endIndex - current.startIndex,
            );
          else nested.push(...child.children);
        }
        if (prefix === undefined || /[;&|<>()#\\\n]/.test(bytes.toString())) {
          edits.push([current.startIndex, current.endIndex, '$HOME""']);
          continue;
        }
        edits.push(
          [current.startIndex, current.startIndex + prefix, ""],
          [current.endIndex - 1, current.endIndex, ""],
        );
        stack.push(...current.children);
      } else if (
        current.type.endsWith("expansion") &&
        current.text !== "$HOME" &&
        (node.type === "command" ||
          !node.text.includes(`${current.text.slice(1)}=`))
      )
        edits.push([current.startIndex, current.endIndex, "__OTHER_VAR__"]);
      else stack.push(...current.children);
    }
    let bytes = Buffer.from(node.text);
    edits.sort((a, b) => b[0] - a[0]);
    for (const [index, [start, end, replacement]] of edits.entries()) {
      if (start === edits[index - 1]?.[0]) continue;
      bytes = Buffer.concat([
        bytes.subarray(0, start - node.startIndex),
        Buffer.from(replacement),
        bytes.subarray(end - node.startIndex),
      ]);
    }
    const semantic = active
      ? await oR(bytes.toString(), { readsDivergentShapes: true })
      : undefined;
    const results: Nested[] = [];
    for (const command of semantic?.kind === "simple"
      ? semantic.commands
      : []) {
      const argv = x5e(l1(command.argv));
      const name = sD(argv[0]);
      if (name !== "rm" && name !== "rmdir") continue;
      const original = argv
        .slice(1)
        .filter(
          (word) =>
            word.startsWith("-") ||
            (!word.includes("__OTHER_VAR__") &&
              (!absoluteOnly ||
                word.startsWith("~") ||
                paths.isAbsolute(word))),
        );
      const empty = original.map((word) =>
        word.replace(
          /(.)(?:__CMDSUB__(?:(?!\.\.)[/*.])*)+((?:\/\.\.)*)\/*$/,
          "$1$2",
        ),
      );
      for (const args of edits.some((edit) => edit[2] === "__CMDSUB__")
        ? [original, empty]
        : [original]) {
        const result = o2(name, args, cwd, permission, false);
        if (result.behavior === "ask")
          results.push(
            args === original
              ? { result, kind: "literalTarget" }
              : { result: xbn(result), kind: "emptyExpansion" },
          );
      }
    }
    return results;
  }
  return {
    policy,
    semantic,
    preparation,
    native: { jbn, sb, O5e, Lbn, $Or, MOr, xbn, slt },
    withPolicyScope<T>(
      policyValue: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { scope: { policyId: policyValue.scope.policyId, cwd }, receipts },
        () => policy.withPolicyScope(policyValue, cwd, run, receipts),
      );
    },
  };
}
