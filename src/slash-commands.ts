/**
 * Built-in slash commands tau implements. `source: "original"` descriptions are
 * the 2.1.326 registry text verbatim; `"tau"` marks a command whose behavior
 * differs from the original's, described as tau behaves.
 */
export const SLASH_COMMANDS = [
  {
    name: "clear",
    aliases: ["reset", "new"],
    description:
      "Start a new session with empty context; previous session stays on disk (resumable with /resume)",
    source: "original",
  },
  {
    name: "compact",
    aliases: [],
    description: "Free up context by summarizing the conversation so far",
    source: "original",
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "Exit the CLI",
    source: "original",
  },
  {
    name: "help",
    aliases: [],
    description: "Show help and available commands",
    source: "original",
  },
  {
    name: "model",
    aliases: [],
    description: "Set the AI model for Claude Code",
    argument: "[model]",
    source: "original",
  },
  {
    name: "permissions",
    aliases: ["allowed-tools"],
    description: "Show or set the permission mode",
    argument: "[mode]",
    source: "tau",
  },
  {
    name: "resume",
    aliases: ["continue"],
    description: "Resume a previous session",
    argument: "<session id>",
    source: "original",
  },
  {
    name: "save",
    aliases: [],
    description: "Save the session to disk now",
    source: "tau",
  },
  {
    name: "skills",
    aliases: [],
    description: "List available skills",
    source: "original",
  },
  {
    name: "status",
    aliases: [],
    description: "Show session, model, permission mode and usage",
    source: "tau",
  },
] as const satisfies readonly {
  name: string;
  aliases: readonly string[];
  description: string;
  argument?: string;
  source: "original" | "tau";
}[];

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]["name"];

/** The built-in a typed name or alias selects. */
export function slashCommand(typed: string): SlashCommandName | undefined {
  return SLASH_COMMANDS.find(
    (command) =>
      command.name === typed ||
      command.aliases.some((alias: string) => alias === typed),
  )?.name;
}

const GOODBYES = ["Goodbye!", "See ya!", "Bye!", "Catch you later!"];

export function goodbye(): string {
  return GOODBYES[Math.floor(Math.random() * GOODBYES.length)] ?? "Goodbye!";
}
