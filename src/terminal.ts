import { stripVTControlCharacters } from "node:util";

export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(
    /[\p{Cc}--[\t\n\u0080-\u009f]]/gv,
    "",
  );
}
