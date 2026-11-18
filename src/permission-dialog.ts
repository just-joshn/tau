import { basename, isAbsolute, relative } from "node:path";
import type { PermissionMode } from "./types.js";

/** What the tool permission gate tells the approver about the call it holds. */
export interface ToolApprovalRequest {
  tool: string;
  /** Canonical target of a file tool. */
  path?: string;
  /** A protected path: the original offers no standing grant for it. */
  sensitive?: boolean;
}

/** A refusal whose message becomes the tool result. */
export interface ToolRejection {
  approved: false;
  message: string;
}

export type ToolApprovalAnswer = boolean | ToolRejection;

/** The original's PermissionUpdate shape, limited to what tau applies. */
export type PermissionUpdate = {
  type: "setMode";
  mode: "acceptEdits";
  destination: "session";
};

export type PermissionChoice =
  | { kind: "accept-once" }
  | { kind: "accept-session"; updates: readonly PermissionUpdate[] }
  | { kind: "reject"; feedback?: string };

export interface PermissionOption {
  label: string;
  choice: PermissionChoice;
}

export interface PermissionDialog {
  title?: string;
  subtitle?: string;
  body: string;
  question: string;
  options: readonly PermissionOption[];
}

const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

/** The tool result for a refusal; without feedback the original also ends the turn. */
export function rejectionMessage(feedback?: string): string {
  return feedback
    ? `${REJECTED} To tell you how to proceed, the user said:\n${feedback}`
    : `${REJECTED} STOP what you are doing and wait for the user to tell you how to proceed.`;
}

export const REJECT_PLACEHOLDER = "and tell Claude what to do differently";
export const DIALOG_FOOTER = "Esc to cancel · Tab to amend";

const ACCEPT_EDITS_LABEL =
  "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)";

function fileAction(tool: string, exists: boolean) {
  switch (tool) {
    case "Edit":
      return { title: "Edit file", verb: "make this edit to" };
    case "Write":
      return exists
        ? { title: "Overwrite file", verb: "overwrite" }
        : { title: "Create file", verb: "create" };
    case "NotebookEdit":
      return { title: "Edit notebook", verb: "make this edit to" };
    default:
      return undefined;
  }
}

/**
 * Builds the dialog the original shows for a tool call. Session row: file edits
 * inside the working directory in default mode switch the session to acceptEdits.
 * Rows tau does not apply (directory grants, `.claude` folder rules, Bash
 * prefixes, local-settings rules) are not offered.
 */
export function permissionDialog(
  request: ToolApprovalRequest,
  description: string,
  context: { cwd: string; mode: PermissionMode; exists: boolean },
): PermissionDialog {
  const yes: PermissionOption = {
    label: "Yes",
    choice: { kind: "accept-once" },
  };
  const no: PermissionOption = { label: "No", choice: { kind: "reject" } };
  const action =
    request.path === undefined
      ? undefined
      : fileAction(request.tool, context.exists);
  if (action === undefined || request.path === undefined)
    return {
      body: description,
      question: "Do you want to proceed?",
      options: [yes, no],
    };
  const local = relative(context.cwd, request.path);
  const inside = local !== "" && !local.startsWith("..") && !isAbsolute(local);
  const session: PermissionOption[] =
    inside && !request.sensitive && context.mode === "default"
      ? [
          {
            label: ACCEPT_EDITS_LABEL,
            choice: {
              kind: "accept-session",
              updates: [
                {
                  type: "setMode",
                  mode: "acceptEdits",
                  destination: "session",
                },
              ],
            },
          },
        ]
      : [];
  return {
    title: action.title,
    subtitle: local,
    body: description.split("\n").slice(1).join("\n"),
    question: `Do you want to ${action.verb} ${basename(request.path)}?`,
    options: [yes, ...session, no],
  };
}
