export const MAX_GLOB_PATTERN = 1024;
const MAX_MATCH_CELLS = 10_000_000;

type Token =
  | { kind: "literal"; value: string }
  | { kind: "one" | "star" | "tree" | "directoryStart" | "directoryBody" };

export function createGlobMatcher(
  pattern: string,
): (candidate: string) => boolean {
  if (!pattern.length || pattern.length > MAX_GLOB_PATTERN)
    throw new Error("Glob pattern must contain 1 to 1024 string units");
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "*" && pattern.charAt(i + 1) === "*") {
      i++;
      if (pattern.charAt(i + 1) === "/") {
        i++;
        tokens.push({ kind: "directoryStart" }, { kind: "directoryBody" });
      } else tokens.push({ kind: "tree" });
    } else if (char === "*") tokens.push({ kind: "star" });
    else if (char === "?") tokens.push({ kind: "one" });
    else tokens.push({ kind: "literal", value: char });
  }
  const close = (states: Uint8Array) => {
    for (const [index, token] of tokens.entries()) {
      if (!states[index]) continue;
      switch (token.kind) {
        case "star":
        case "tree":
          states[index + 1] = 1;
          break;
        // **/ may be absent, or consume a prefix that must end in a slash.
        case "directoryStart":
          states[index + 1] = 1;
          states[index + 2] = 1;
          break;
        case "literal":
        case "one":
        case "directoryBody":
          break;
        default: {
          const exhaustive: never = token;
          throw new Error(`Unknown Glob token: ${exhaustive}`);
        }
      }
    }
  };
  // One query shares its work budget across every candidate, not once per file.
  let remaining = MAX_MATCH_CELLS;
  return (candidate) => {
    remaining -= (candidate.length + 1) * (tokens.length + 1);
    if (remaining < 0)
      throw new Error(
        "Glob matching work limit exceeded; narrow the path or pattern",
      );
    let current = new Uint8Array(tokens.length + 1);
    let next = new Uint8Array(tokens.length + 1);
    current[0] = 1;
    close(current);
    for (let i = 0; i < candidate.length; i++) {
      const char = candidate.charAt(i);
      next.fill(0);
      for (const [index, token] of tokens.entries()) {
        if (!current[index]) continue;
        switch (token.kind) {
          case "literal":
            if (char === token.value) next[index + 1] = 1;
            break;
          case "one":
            if (char !== "/") next[index + 1] = 1;
            break;
          case "star":
            if (char !== "/") next[index] = 1;
            break;
          case "tree":
            next[index] = 1;
            break;
          case "directoryBody":
            next[index] = 1;
            if (char === "/") next[index + 1] = 1;
            break;
          case "directoryStart":
            break;
          default: {
            const exhaustive: never = token;
            throw new Error(`Unknown Glob token: ${exhaustive}`);
          }
        }
      }
      close(next);
      [current, next] = [next, current];
    }
    return current[tokens.length] === 1;
  };
}
