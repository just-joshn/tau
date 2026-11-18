// Surviving mutants whose behaviour cannot differ from the original, keyed by
// the survivor line run.ts prints. Each value says why no test can tell them
// apart. run.ts fails on an entry that no longer matches a mutant.
export const EQUIVALENT_MUTANTS: Readonly<Record<string, string>> = {
  "src/tool-policy.ts:40:43 relational >= → >":
    "The escape scan walks left from the character before ')'. Index 0 is the A of Agent( or the T of Task(, never a backslash, so stopping above 0 counts the same escapes.",
  "src/tool-policy.ts:204:11 relational > → >=":
    "A colon at 0 leaves an empty key, so `key && pattern` fails and the same Unsupported settings permission rule error is thrown.",
  "src/tool-policy.ts:301:13 relational <= → <":
    "A colon at 0 makes the key empty, which `!key` in the same condition rejects, so the rule still matches nothing.",
  "src/tool-policy.ts:341:13 relational <= → <":
    "A colon at 0 makes the key empty, which `!key` in the same condition rejects, so the rule still matches nothing.",
};
