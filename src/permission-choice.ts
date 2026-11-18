import type { Interface } from "node:readline/promises";
import {
  REJECT_PLACEHOLDER,
  renderPermissionDialog,
  type PermissionChoice,
  type PermissionDialog,
} from "./permission-dialog.js";
import { replaceProvisional, terminalText as safe } from "./terminal.js";

interface Key {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
}

export interface ChoiceTerminal {
  readline: Interface;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

type Outcome = PermissionChoice | { kind: "amend" };

/**
 * Shows the dialog and reads single keys while readline's own key handling is
 * set aside: a number picks its option, arrows move the focus, Enter picks the
 * focused option, Esc or Ctrl-C refuses, shift+tab takes the session row and Tab
 * asks for feedback to send with a refusal.
 */
export async function choosePermission(
  terminal: ChoiceTerminal,
  dialog: PermissionDialog,
  signal?: AbortSignal,
): Promise<PermissionChoice> {
  const { readline, input, output } = terminal;
  const options = dialog.options;
  let focus = 0;
  let shown = renderPermissionDialog(dialog, focus);
  output.write(safe(shown));
  const held = input
    .listeners("keypress")
    .filter(
      (listener): listener is (...args: unknown[]) => void =>
        typeof listener === "function",
    );
  for (const listener of held) input.removeListener("keypress", listener);
  let outcome: Outcome;
  try {
    outcome = await new Promise<Outcome>((resolve, reject) => {
      const settle = () => {
        input.removeListener("keypress", onKey);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        settle();
        reject(signal?.reason);
      };
      const done = (value: Outcome) => {
        settle();
        resolve(value);
      };
      const onKey = (text: string | undefined, key: Key = {}) => {
        const picked = /^[1-9]$/.test(text ?? "")
          ? options[Number(text) - 1]
          : undefined;
        if (picked) return done(picked.choice);
        const focused = options[focus];
        if (focused && (key.name === "return" || key.name === "enter"))
          return done(focused.choice);
        if (key.name === "escape" || (key.ctrl && key.name === "c"))
          return done({ kind: "reject" });
        if (key.name === "tab" && key.shift) {
          const session = options.find(
            (option) => option.choice.kind === "accept-session",
          );
          if (session) done(session.choice);
          return;
        }
        if (key.name === "tab") return done({ kind: "amend" });
        if (key.name !== "up" && key.name !== "down") return;
        focus =
          (focus + (key.name === "up" ? options.length - 1 : 1)) %
          options.length;
        const next = renderPermissionDialog(dialog, focus);
        output.write(replaceProvisional(shown, next, output.columns || 80));
        shown = next;
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      input.on("keypress", onKey);
    });
  } finally {
    for (const listener of held) input.on("keypress", listener);
  }
  if (outcome.kind !== "amend") return outcome;
  const feedback = (
    await readline.question(
      `No, ${REJECT_PLACEHOLDER}: `,
      signal ? { signal } : {},
    )
  ).trim();
  return feedback ? { kind: "reject", feedback } : { kind: "reject" };
}
