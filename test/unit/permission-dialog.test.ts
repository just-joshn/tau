import { describe, expect, test } from "bun:test";
import {
  permissionDialog,
  rejectionMessage,
} from "../../src/permission-dialog.js";
import { slashCommand } from "../../src/slash-commands.js";

const cwd = "/work";
const labels = (dialog: ReturnType<typeof permissionDialog>) =>
  dialog.options.map((option) => option.label);
const SESSION =
  "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)";

describe("permission dialog model", () => {
  test("Write names create or overwrite by whether the file exists", () => {
    const write = (exists: boolean) =>
      permissionDialog(
        { tool: "Write", path: "/work/src/a.ts" },
        "Write /work/src/a.ts\nProposed content:\nx",
        { cwd, mode: "default", exists },
      );
    expect(write(false)).toMatchObject({
      title: "Create file",
      subtitle: "src/a.ts",
      body: "Proposed content:\nx",
      question: "Do you want to create a.ts?",
    });
    expect(write(true)).toMatchObject({
      title: "Overwrite file",
      question: "Do you want to overwrite a.ts?",
    });
    expect(labels(write(true))).toEqual(["Yes", SESSION, "No"]);
  });

  test("the session row needs default mode, a path inside cwd and no protected target", () => {
    const edit = (
      path: string,
      mode: "default" | "acceptEdits" | "plan",
      sensitive = false,
    ) =>
      labels(
        permissionDialog({ tool: "Edit", path, sensitive }, "Edit x", {
          cwd,
          mode,
          exists: true,
        }),
      );
    expect(edit("/work/a.txt", "default")).toEqual(["Yes", SESSION, "No"]);
    expect(edit("/elsewhere/a.txt", "default")).toEqual(["Yes", "No"]);
    expect(edit("/work/.claude/settings.json", "default", true)).toEqual([
      "Yes",
      "No",
    ]);
    expect(edit("/work/a.txt", "plan")).toEqual(["Yes", "No"]);
  });

  test("the session row switches the session to acceptEdits", () => {
    const dialog = permissionDialog(
      { tool: "Edit", path: "/work/a.txt" },
      "Edit",
      { cwd, mode: "default", exists: true },
    );
    expect(dialog.options[1]?.choice).toEqual({
      kind: "accept-session",
      updates: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    });
  });

  test("other tools get the generic question over their description", () => {
    expect(
      permissionDialog({ tool: "Bash" }, "Run Bash: ls", {
        cwd,
        mode: "default",
        exists: false,
      }),
    ).toEqual({
      body: "Run Bash: ls",
      question: "Do you want to proceed?",
      options: [
        { label: "Yes", choice: { kind: "accept-once" } },
        { label: "No", choice: { kind: "reject" } },
      ],
    });
  });

  test("refusals carry the original's tool result text", () => {
    expect(rejectionMessage()).toEndWith(
      "NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    );
    expect(rejectionMessage("use gamma")).toEndWith(
      "NOT written to the file). To tell you how to proceed, the user said:\nuse gamma",
    );
  });
});

test("slash command aliases resolve to their built-in", () => {
  expect(
    ["quit", "reset", "new", "allowed-tools", "continue", "help", "nope"].map(
      slashCommand,
    ),
  ).toEqual([
    "exit",
    "clear",
    "clear",
    "permissions",
    "resume",
    "help",
    undefined,
  ]);
});
