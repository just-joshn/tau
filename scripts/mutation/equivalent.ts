// Surviving mutants whose behaviour cannot differ from the original, keyed by
// the survivor line run.ts prints. Each value says why no test can tell them
// apart. run.ts fails on an entry that no longer matches a mutant.
export const EQUIVALENT_MUTANTS: Readonly<Record<string, string>> = {};
