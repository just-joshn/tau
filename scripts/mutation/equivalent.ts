export const EQUIVALENT_MUTANTS: Readonly<Record<string, string>> = {
  "src/tool-policy.ts:41:43 relational >= → >":
    "The escape scan walks left from the character before ')'. Index 0 is the A of Agent( or the T of Task(, never a backslash, so stopping above 0 counts the same escapes.",
  "src/tool-policy.ts:221:19 relational > → >=":
    "A colon at 0 leaves an empty key, so `key && pattern` fails and the Read/Write/Edit/Bash call rule gets no parameter either way.",
  "src/tool-policy.ts:250:11 relational > → >=":
    "A colon at 0 leaves an empty key, so `key && pattern` fails and the same Unsupported settings permission rule error is thrown.",
  "src/tool-policy.ts:294:37 logical && → ||":
    "The mutant also enters the built-in branch when the rule is a Read/Write/Edit/Bash call but serverName is set or the name is outside that family. serverName is set only for mcp__-qualified external tools, so in every such case parsed.toolName differs from the name and the branch returns false. The original fall-through returns false too: the rule starts with a built-in name, so it is not Agent/Task, a background-task name or an mcp__ rule, and its '(' keeps it from equalling any registered tool name.",
  "src/tool-policy.ts:395:13 relational <= → <":
    "A colon at 0 makes the key empty, which `!key` in the same condition rejects, so the rule still matches nothing.",
  "src/tool-policy.ts:435:13 relational <= → <":
    "A colon at 0 makes the key empty, which `!key` in the same condition rejects, so the rule still matches nothing.",
  "src/permission-prompt.ts:166:53 boolean-literal true → false":
    "abortable removes its abort listener in cleanup before it rejects and when the pending call settles, and an AbortSignal dispatches abort at most once, so `once` never has a second event to drop.",
};
