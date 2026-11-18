/** Numeric and boolean setting grammar shared by the recovered transport controls. */
const grouped = /^[+-]?\d{1,3}([_,\u00a0\u202f ])\d{3}(?:\1\d{3})*$/;
const scientific = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/;

function groupedNumber(text: string): number | undefined {
  return text.length <= 32 && grouped.test(text)
    ? Number(text.replace(/[_,\u00a0\u202f ]/g, ""))
    : undefined;
}
export function integerSetting(
  value: string | undefined,
  minimum = -Infinity,
  maximum = Infinity,
  digitsOnly = false,
): number | undefined {
  if (value === undefined) return;
  const text = value.trim();
  if (digitsOnly && !/^[+-]?\d+$/.test(text)) return;
  let parsed = groupedNumber(text);
  if (parsed === undefined && text.length <= 32 && scientific.test(text)) {
    const numeric = Number(text);
    parsed = Number.isInteger(numeric) ? numeric : NaN;
  }
  parsed ??= parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}
export function positiveRawNumber(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return;
  const numeric = Number(value);
  const parsed = Number.isNaN(numeric) ? groupedNumber(value.trim()) : numeric;
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}
export function triBoolean(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (text && ["1", "true", "yes", "on"].includes(text)) return true;
  if (text && ["0", "false", "no", "off"].includes(text)) return false;
}
