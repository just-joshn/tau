/**
 * The Bash tool's model-facing contract: input schema and description,
 * rendered from the same gates as the original (chunk-4h798pp0 bPn/M2r/kPn,
 * chunk-zk95hkj7 U6r/B6r, chunk-xj0yvmna Yq/zee).
 */
import { integerSetting, triBoolean } from "./env-settings.js";

/** Facts the original's gates read. A host computes them once per definition. */
export interface BashPromptFacts {
  platform: NodeJS.Platform;
  /** The shell the original's description probe (UGr) finds, if any. */
  shellPath: string | undefined;
  /** RI(): `find`/`grep` are shell functions backed by embedded tools; tau has Glob/Grep instead. */
  embeddedSearch: boolean;
  /** bXe()/Ip(): CLAUDE_CODE_DISABLE_BACKGROUND_TASKS. */
  backgroundDisabled: boolean;
  /** __n(): non-interactive sessions stop background commands at a deadline. */
  backgroundDeadline: boolean;
  /** x0n(): CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR. */
  maintainProjectDir: boolean;
  /** akt(): CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS unset or false. */
  gitInstructions: boolean;
  /** x1(): TaskCreate unless CLAUDE_CODE_ENABLE_TASKS is false. */
  taskToolName: "TaskCreate" | "TodoWrite";
  timeouts: BashTimeouts;
}
export interface BashTimeouts {
  defaultMs: number;
  maxMs: number;
  backgroundDefaultMs: number;
  backgroundMaxMs: number;
}

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const BACKGROUND_MAX_MS = 7200000;
const SINGLE_SHOT_BACKGROUND_MS = 600000;
const BACKGROUND_DEFAULT_MS = 1800000;
const positive = (value: string | undefined) => {
  const parsed = integerSetting(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
};
/**
 * Yq/zee/Aje/y_n: env overrides; the maximum never drops below the default.
 * A single-shot print session (`-p` without stream-json input) gives
 * background commands 10 minutes by default, other sessions 30.
 */
export function bashTimeouts(
  env: NodeJS.ProcessEnv,
  singleShot = true,
): BashTimeouts {
  const defaultMs = positive(env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const maxMs = Math.max(
    positive(env.BASH_MAX_TIMEOUT_MS) ?? MAX_TIMEOUT_MS,
    defaultMs,
  );
  const backgroundMaxMs = Math.min(
    Math.max(BACKGROUND_MAX_MS, maxMs),
    2147483647,
  );
  const base = singleShot ? SINGLE_SHOT_BACKGROUND_MS : BACKGROUND_DEFAULT_MS;
  return {
    defaultMs,
    maxMs,
    backgroundDefaultMs: Math.min(Math.max(base, defaultMs), backgroundMaxMs),
    backgroundMaxMs,
  };
}
export interface BashSessionKind {
  /** DC(): print/SDK sessions, as opposed to the interactive terminal. */
  nonInteractive: boolean;
  /** B5(): print mode without stream-json input. */
  singleShot: boolean;
}
export function bashPromptFacts(
  env: NodeJS.ProcessEnv,
  shellPath: string | undefined,
  session: BashSessionKind = { nonInteractive: true, singleShot: true },
): BashPromptFacts {
  const git = triBoolean(env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS);
  return {
    platform: process.platform,
    shellPath,
    embeddedSearch: false,
    backgroundDisabled:
      triBoolean(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) === true,
    backgroundDeadline: session.nonInteractive,
    maintainProjectDir:
      triBoolean(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR) === true,
    gitInstructions: git === undefined ? true : !git,
    taskToolName:
      triBoolean(env.CLAUDE_CODE_ENABLE_TASKS) === false
        ? "TodoWrite"
        : "TaskCreate",
    timeouts: bashTimeouts(env, session.singleShot),
  };
}

const COMMAND_DESCRIPTION = `Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

Say what the command does in plain words: do not echo the command's text, its flags, or file paths - the user reads this description, often without seeing the command.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`;

/** Lxi()/mWo(): run_in_background is omitted when background tasks are disabled. */
export function bashInputSchema(facts: BashPromptFacts) {
  const { timeouts } = facts;
  const properties: Record<string, { description: string; type: string }> = {
    command: { description: "The command to execute", type: "string" },
    timeout: {
      description: `Optional timeout in milliseconds (max ${timeouts.maxMs} for a foreground command)`,
      type: "number",
    },
    description: { description: COMMAND_DESCRIPTION, type: "string" },
    ...(facts.backgroundDisabled
      ? {}
      : {
          run_in_background: {
            description: facts.backgroundDeadline
              ? `Set to true to run this command in the background. With it, \`timeout\` limits how long the command may run in the background before it is stopped (default ${timeouts.backgroundDefaultMs} ms, max ${timeouts.backgroundMaxMs} ms).`
              : "Set to true to run this command in the background.",
            type: "boolean",
          },
        }),
    dangerouslyDisableSandbox: {
      description:
        "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
      type: "boolean",
    },
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    properties,
    required: ["command"],
    additionalProperties: false,
  };
}

const bullets = (items: readonly (string | readonly string[])[]) =>
  items.flatMap((item) =>
    typeof item === "string" ? [` - ${item}`] : item.map((sub) => `  - ${sub}`),
  );
const minutes = (ms: number) => ms / 60000;
const COMMUNICATION = "Communication: Output text directly (NOT echo/printf)";
const ATTRIBUTION =
  "the attribution lines given in the conversation's system-reminder, when one is present";

/** iKs(): macOS /bin/bash 3.2 cannot run a heredoc inside `$(...)` reliably. */
const teachesHeredocOnStdin = (facts: BashPromptFacts) =>
  facts.platform === "darwin" && facts.shellPath === "/bin/bash";

function heredocNote(facts: BashPromptFacts): string | undefined {
  if (!teachesHeredocOnStdin(facts)) return;
  const [example, refused] = facts.gitInstructions
    ? [
        " (`git commit -F - <<'EOF'`, `gh pr create --body-file - <<'EOF'`)",
        "those options",
      ]
    : [" with `<<'EOF'`", "that"];
  return `This tool runs macOS's /bin/bash (version 3.2), too old to run a heredoc inside \`$(...)\` reliably. Never write \`"$(cat <<'EOF' … EOF)"\`, even where other instructions show it. Pass multi-line text on stdin${example} and end the command at \`EOF\`: run what follows as a separate call. Where a command cannot read stdin, or a skill refuses ${refused}, use one single-quoted string, writing each \`'\` as \`'\\''\`.`;
}

/** B6r(): the background deadline sentence, only where a deadline applies. */
function backgroundDeadline(facts: BashPromptFacts): string {
  if (!facts.backgroundDeadline) return "";
  const { backgroundDefaultMs: base, backgroundMaxMs: max } = facts.timeouts;
  const limit =
    max < BACKGROUND_MAX_MS
      ? `${Math.round(max / 60000)} minutes`
      : `${Math.round(max / 3600000)} hours`;
  return ` With \`run_in_background\` the timeout is instead how long the command may run in the background (default ${base}ms / ${Math.round(base / 60000)} minutes, max ${max}ms / ${limit}); at that limit it is stopped and you are notified.`;
}
/** kPn(): fTe() on, Dut() off, cPn()/pPn() empty in a local session. */
function backgroundInstruction(facts: BashPromptFacts): string | undefined {
  if (facts.backgroundDisabled) return;
  return `You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.${backgroundDeadline(facts)}`;
}

function gitSection(facts: BashPromptFacts): string {
  if (!facts.gitInstructions) return "";
  const heredoc = teachesHeredocOnStdin(facts);
  const commitExample = heredoc
    ? "git commit -F - <<'EOF'\nCommit message here.\nEOF"
    : `git commit -m "$(cat <<'EOF'\n   Commit message here.\n   EOF\n   )"`;
  const tools = `${facts.taskToolName} or Agent`;
  return `# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:

You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. The numbered steps below indicate which commands should be batched in parallel.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

1. Run the following bash commands in parallel, each using the Bash tool:
  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - Run a git diff command to see both staged and unstaged changes that will be committed.
  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, .claude/settings.local.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following commands in parallel:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message, ending with ${ATTRIBUTION}.
   - Run git status after the commit completes to verify success.
   Note: git status depends on the commit completing, so run it sequentially after the commit.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:
- NEVER run additional commands to read or explore code, besides git bash commands
- NEVER use the ${tools} tools
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:
<example>
${commitExample}
</example>

# Creating pull requests
Use the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.

GitHub notifies the owner of any \`@name\` written in a PR, issue, or comment. Write a bare \`@name\` only for a real login you mean to notify. Put roles, placeholders, and code (\`@human\`, \`@reviewer\`, \`@types/node\`) in backticks or drop the \`@\`, even when copied from project files.

IMPORTANT: When the user asks you to create a pull request, follow these steps carefully:

1. Run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:
   - Run a git status command to see all untracked files (never use -uall flag)
   - Run a git diff command to see both staged and unstaged changes that will be committed
   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote
   - Run a git log command and \`git diff [base-branch]...HEAD\` to understand the full commit history for the current branch (from the time it diverged from the base branch)
2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:
   - Keep the PR title short (under 70 characters)
   - Use the description/body for details, not the title
3. Run the following commands in parallel:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting. End the body with ${ATTRIBUTION}.
<example>
gh pr create --title "the pr title" ${heredoc ? "--body-file - <<'EOF'" : `--body "$(cat <<'EOF'`}
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]
EOF${heredoc ? "" : '\n)"'}
</example>

Important:
- DO NOT use the ${tools} tools
- Return the PR URL when you're done, so the user can see it

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`;
}

/** bPn(): the full (non-lean) Bash description. */
export function bashDescription(facts: BashPromptFacts): string {
  const { timeouts } = facts;
  const background = !facts.backgroundDisabled;
  const dedicated = [
    ...(facts.embeddedSearch
      ? []
      : [
          "File search: Use Glob (NOT find or ls)",
          "Content search: Use Grep (NOT grep or rg)",
        ]),
    "Read files: Use Read (NOT cat/head/tail)",
    "Edit files: Use Edit (NOT sed/awk)",
    "Write files: Use Write (NOT echo >/cat <<EOF)",
    COMMUNICATION,
  ];
  const avoided = facts.embeddedSearch
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";
  const sleep = [
    "Do not sleep between commands that can run immediately — just run them.",
    background
      ? 'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.'
      : "Use the Monitor tool to stream events from a background process (each stdout line is a notification).",
    ...(background
      ? [
          "If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed.",
        ]
      : []),
    "Do not retry failing commands in a sleep loop — diagnose the root cause.",
    ...(background
      ? [
          "If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.",
          "Long leading `sleep` commands are blocked. To poll until a condition is met, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`) — you get a notification when the loop exits. Do not chain shorter sleeps to work around the block.",
        ]
      : [
          "If you must poll an external process, use a check command (e.g. `gh run view`) rather than sleeping first.",
          "If you must sleep, keep the duration short to avoid blocking the user.",
        ]),
  ];
  const backgroundLine = backgroundInstruction(facts);
  const instructions = [
    "If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.",
    'Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")',
    "Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it. In particular, never prepend `cd <current-directory>` to a `git` command — `git` already operates on the current working tree, and the compound triggers a permission prompt.",
    `You may specify an optional timeout in milliseconds (up to ${timeouts.maxMs}ms / ${minutes(timeouts.maxMs)} minutes for a foreground command). By default, your command will timeout after ${timeouts.defaultMs}ms (${minutes(timeouts.defaultMs)} minutes).`,
    ...(backgroundLine === undefined ? [] : [backgroundLine]),
    "For git commands:",
    [
      "Prefer to create a new commit rather than amending an existing commit.",
      "Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.",
      "Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.",
    ],
    "Avoid unnecessary `sleep` commands:",
    sleep,
    ...(facts.embeddedSearch
      ? [
          "When running `find`, search from `.` (or a specific path), not `/` — scanning the full filesystem can exhaust system resources on large trees.",
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ];
  const cwd = facts.maintainProjectDir
    ? "Every call starts in the start folder: a `cd` does not carry over."
    : "`cd` carries to the next call only in the main session, if the command succeeds and ends inside the working directories. Outside them the shell returns to the start folder; otherwise it stays where it was.";
  const heredoc = heredocNote(facts);
  const git = gitSection(facts);
  return [
    "Executes a given bash command and returns its output.",
    ...(heredoc === undefined ? [] : ["", heredoc]),
    "",
    `${cwd} Shell state does not persist. The shell environment is initialized from the user's profile (bash or zsh).`,
    "",
    `IMPORTANT: Avoid using this tool to run ${avoided} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:`,
    "",
    ...bullets(dedicated),
    "While the Bash tool can do similar things, it’s better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.",
    "",
    "# Instructions",
    ...bullets(instructions),
    "",
    ...(git ? ["", git] : []),
  ].join("\n");
}
