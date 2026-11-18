import { homedir } from "node:os";
import type { SettingsSource } from "../configuration.js";
import { bakedDirectModelAliases } from "../direct-model-alias.js";
import { resolveModelFacts } from "../reasoning.js";
import { SLASH_COMMANDS } from "../slash-commands.js";
import type { CommandEntry, Field, ModelChoice, StatusTab } from "./state.js";

/** "claude-sonnet-4-5-20250929" → "Sonnet 4.5"; unknown ids stay as given. */
export function modelLabel(model: string): string {
  const canonical = resolveModelFacts(model).canonical;
  const modern = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/.exec(
    canonical,
  );
  const legacy = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/.exec(canonical);
  const [family, major, minor] = modern
    ? [modern[1], modern[2], modern[3]]
    : legacy
      ? [legacy[3], legacy[1], legacy[2]]
      : [];
  if (!family) return model;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

/** The home directory shown as `~`, as the original's header prints it. */
export function displayPath(path: string, home = homedir()): string {
  return home && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

const FAMILIES = [
  ["Opus", bakedDirectModelAliases.opus, "Best for everyday, complex tasks"],
  [
    "Fable",
    bakedDirectModelAliases.fable,
    "Most capable for your hardest and longest-running tasks",
  ],
  ["Sonnet", bakedDirectModelAliases.sonnet, "Efficient for routine tasks"],
  ["Haiku", bakedDirectModelAliases.haiku, "Fastest for quick answers"],
] as const;

/** The /model picker rows: the default, each family alias, then a custom current model. */
export function modelChoices(
  current: string,
  defaultModel: string,
): ModelChoice[] {
  const same = (model: string) =>
    resolveModelFacts(model).canonical === resolveModelFacts(current).canonical;
  const choices: ModelChoice[] = [
    {
      label: "Default (recommended)",
      description: `Use the default model (currently ${modelLabel(defaultModel)})`,
      model: defaultModel,
      current: false,
    },
    ...FAMILIES.map(([label, model, description]) => ({
      label,
      description: `${modelLabel(model)} · ${description}`,
      model,
      current: same(model),
    })),
  ];
  if (!choices.some((choice) => choice.current))
    choices.push({
      label: modelLabel(current),
      description: current,
      model: current,
      current: true,
    });
  return choices;
}

const SOURCE_LABELS: Readonly<Record<SettingsSource, string>> = {
  userSettings: "User settings",
  projectSettings: "Project settings",
  localSettings: "Local settings",
  flagSettings: "Command line arguments",
  policySettings: "Enterprise managed settings",
};

export interface StatusFacts {
  version: string;
  sessionId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: string;
  settingSources: readonly SettingsSource[];
  messages: number;
  usage: { input_tokens: number; output_tokens: number };
}

/** The Settings dialog's Status tab, limited to fields tau has, and a token Usage tab. */
export function statusFields(
  facts: StatusFacts,
): Record<StatusTab, readonly Field[]> {
  return {
    status: [
      ["Version:", facts.version],
      ["Session ID:", facts.sessionId],
      ["Session kind:", "interactive"],
      ["cwd:", facts.cwd],
      ["Auth token:", "none"],
      ["API key:", "ANTHROPIC_API_KEY"],
      ...(facts.env.ANTHROPIC_BASE_URL
        ? [["Anthropic base URL:", facts.env.ANTHROPIC_BASE_URL] as const]
        : []),
      ["", ""],
      ["Model:", facts.model],
      [
        "Setting sources:",
        facts.settingSources.map((source) => SOURCE_LABELS[source]).join(", "),
      ],
    ],
    usage: [
      ["Messages:", String(facts.messages)],
      ["Input tokens:", String(facts.usage.input_tokens)],
      ["Output tokens:", String(facts.usage.output_tokens)],
    ],
  };
}

/** The slash-command suggestions: built-ins, then skills. */
export function commandEntries(
  skills: readonly { name: string; description: string }[],
  model: string,
): CommandEntry[] {
  return [
    ...SLASH_COMMANDS.map((command) => ({
      name: command.name,
      description:
        command.name === "model"
          ? `${command.description} (currently ${modelLabel(model)})`
          : command.description,
    })),
    ...skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    })),
  ];
}

/** Printed after the screen closes: how to come back to this session. */
export function resumeHint(sessionId: string, model?: string): string {
  return `\nResume this session with:\ntau ${model ? `--model ${model} ` : ""}--resume ${sessionId}\n`;
}
