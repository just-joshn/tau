import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
} from "./security-types.js";

/** Source u4e Stack behavior for the object keys used by the native equality closure. */
class EqualityStack {
  private entries: [object, object][] = [];
  private promoted: Map<object, object> | undefined;

  get(key: object): object | undefined {
    if (this.promoted) return this.promoted.get(key);
    return this.entries.findLast((entry) => entry[0] === key)?.[1];
  }
  set(key: object, value: object): void {
    if (this.promoted) this.promoted.set(key, value);
    else if (this.entries.length < 199) this.entries.push([key, value]);
    else {
      this.promoted = new Map(this.entries);
      this.promoted.set(key, value);
      this.entries = [];
    }
  }
  delete(key: object): void {
    if (this.promoted) this.promoted.delete(key);
    else {
      const index = this.entries.findLastIndex((entry) => entry[0] === key);
      if (index !== -1) this.entries.splice(index, 1);
    }
  }
}
function map(value: unknown): value is ReadonlyMap<unknown, unknown> {
  return value instanceof Map;
}
function record(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}
function array(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function ordinary(value: Record<PropertyKey, unknown>): void {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    (prototype !== null && prototype !== Object.prototype) ||
    Symbol.toStringTag in value ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) =>
        descriptor.get !== undefined || descriptor.set !== undefined,
    )
  )
    throw new NativeBashSecurityUnsupported(
      "equality.nativeOutcomeDomain",
      "Native Bash outcome equality requires its actual ordinary object/JSON/Map producers",
    );
}
function ownKeys(value: Record<PropertyKey, unknown>): PropertyKey[] {
  return [
    ...Object.keys(value),
    ...Object.getOwnPropertySymbols(value).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(value, key),
    ),
  ];
}
function unwrap(value: Record<PropertyKey, unknown>): unknown {
  const method = value.value;
  if (typeof method !== "function")
    throw new TypeError("Native wrapped value is not callable");
  const result: unknown = method.call(value);
  return result;
}

/** Tn/pfr's two-argument call on the closed native permission-outcome domain.
 * Maps propagate native unordered comparison into entry arrays and their descendants.
 * Missing keys differ from explicit undefined; array holes equal undefined elements.
 * This is not a replacement for generic pfr on boxed values, typed buffers or class instances.
 * A caller introducing those values must supply the corresponding native source closure.
 */
export function equalNativeBashOutcomes(
  left: Decision,
  right: Decision,
): boolean {
  const stack = new EqualityStack();
  const requiredKey = (key: PropertyKey | undefined): PropertyKey => {
    if (key === undefined)
      throw new Error("Missing native equality key invariant");
    return key;
  };
  function arrays(a: unknown[], b: unknown[], unordered: boolean): boolean {
    if (a.length !== b.length) return false;
    const first = stack.get(a);
    const second = stack.get(b);
    if (first && second) return first === b && second === a;
    const used = unordered ? new Set<number>() : undefined;
    stack.set(a, b);
    stack.set(b, a);
    let result = true;
    for (let index = 0; index < a.length; index++) {
      const value = a[index];
      if (used) {
        let found = false;
        for (let other = 0; other < b.length; other++)
          if (
            !used.has(other) &&
            (value === b[other] || equal(value, b[other], unordered))
          ) {
            used.add(other);
            found = true;
            break;
          }
        if (!found) {
          result = false;
          break;
        }
      } else if (!(value === b[index] || equal(value, b[index], unordered))) {
        result = false;
        break;
      }
    }
    stack.delete(a);
    stack.delete(b);
    return result;
  }
  function equal(a: unknown, b: unknown, unordered = false): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (!record(a) && !record(b)) return a !== a && b !== b;
    if (array(a) || array(b))
      return array(a) && array(b) && arrays(a, b, unordered);

    const aMap = map(a);
    const bMap = map(b);
    const aObject = record(a) && !aMap;
    const bObject = record(b) && !bMap;
    if (aObject) ordinary(a);
    if (bObject) ordinary(b);
    const aWrapped = aObject && Object.hasOwn(a, "__wrapped__");
    const bWrapped = bObject && Object.hasOwn(b, "__wrapped__");
    if (aWrapped || bWrapped)
      return equal(
        aWrapped ? unwrap(a) : a,
        bWrapped ? unwrap(b) : b,
        unordered,
      );

    if (aMap || bMap) {
      if (!aMap || !bMap) return false;
      if (
        Object.hasOwn(a, Symbol.toStringTag) ||
        Object.hasOwn(b, Symbol.toStringTag)
      )
        throw new NativeBashSecurityUnsupported(
          "equality.nativeOutcomeDomain",
          "A tagged Map needs the native raw-tag masking closure",
        );
      if (a.size !== b.size) return false;
      const previous = stack.get(a);
      if (previous) return previous === b;
      stack.set(a, b);
      const first: unknown[] = [];
      const second: unknown[] = [];
      a.forEach((value, key) => {
        first.push([key, value]);
      });
      b.forEach((value, key) => {
        second.push([key, value]);
      });
      const result = arrays(first, second, true);
      stack.delete(a);
      return result;
    }
    if (!aObject || !bObject) return false;
    const firstKeys = ownKeys(a);
    const secondKeys = ownKeys(b);
    if (firstKeys.length !== secondKeys.length) return false;
    for (let index = firstKeys.length - 1; index >= 0; index--)
      if (!Object.hasOwn(b, requiredKey(firstKeys[index]))) return false;
    const first = stack.get(a);
    const second = stack.get(b);
    if (first && second) return first === b && second === a;
    stack.set(a, b);
    stack.set(b, a);
    let result = true;
    let skipConstructor = false;
    for (const key of firstKeys) {
      const one = a[key];
      const two = b[key];
      if (!(one === two || equal(one, two, unordered))) {
        result = false;
        break;
      }
      if (!skipConstructor) skipConstructor = key === "constructor";
    }
    if (result && !skipConstructor) {
      const one = a.constructor;
      const two = b.constructor;
      if (
        one !== two &&
        "constructor" in a &&
        "constructor" in b &&
        !(
          typeof one === "function" &&
          one instanceof one &&
          typeof two === "function" &&
          two instanceof two
        )
      )
        result = false;
    }
    stack.delete(a);
    stack.delete(b);
    return result;
  }
  return equal(left, right);
}
