import { expect, test } from "bun:test";
import {
  applyMutant,
  describeMutant,
  enumerateMutants,
} from "../../scripts/mutation/mutants.ts";

const fixture = [
  "type Flag = true | false;",
  "interface Shape { open: boolean }",
  "export function allowed(name: string, list: readonly string[]): boolean {",
  "  if (!list.includes(name)) return false;",
  '  return name.length > 0 && name !== "Bash";',
  "}",
  'export const label = (on: boolean) => (on ? "on" : "off");',
  'while (allowed("Read", [])) break;',
  "export const strict = true as boolean;",
  "export const same = (a: number) => (a) <= (1);",
  "",
].join("\n");

test("mutants cover every operator at runtime positions and skip type-only ones", () => {
  expect(enumerateMutants(fixture).map(describeMutant)).toEqual([
    "4:7 remove-not !list.includes(name) → list.includes(name)",
    "4:36 boolean-literal false → true",
    '5:10 negate-return name.length > 0 && name !== "Bash" → !(name.length > 0 && name !== "Bash")',
    "5:22 relational > → >=",
    "5:26 logical && → ||",
    "5:34 equality !== → ===",
    "7:40 negate-test on → !(on)",
    '8:8 negate-test allowed("Read", []) → !(allowed("Read", []))',
    "9:23 boolean-literal true → false",
    "10:40 relational <= → <",
  ]);
});

test("a mutant changes only its own range and the result still parses", () => {
  const mutants = enumerateMutants(fixture);
  for (const mutant of mutants) {
    const mutated = applyMutant(fixture, mutant);
    expect(mutated.slice(0, mutant.start)).toBe(fixture.slice(0, mutant.start));
    expect(mutated.slice(mutant.start + mutant.replacement.length)).toBe(
      fixture.slice(mutant.end),
    );
    expect(() => enumerateMutants(mutated)).not.toThrow();
  }
  const relational = mutants.find(
    ({ line, column }) => line === 10 && column === 40,
  );
  expect(relational && applyMutant(fixture, relational)).toBe(
    fixture.replace("(a) <= (1)", "(a) < (1)"),
  );
});
