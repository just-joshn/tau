import { AsyncLocalStorage } from "node:async_hooks";
import type { createNativeBashSecurityPolicyControl } from "./policy-control.js";

type PolicyOwner = ReturnType<typeof createNativeBashSecurityPolicyControl>;
type RemovalScope = { ignoreBelowRm?: boolean };
type CheckoutScope = { untrustedCheckout?: string };
type ByNameScope = { refused: boolean; byName: boolean };

/** Native observation scopes shared by the outer reconciliation and its factual providers. */
export function createNativeBashSecurityObservations(policy: PolicyOwner) {
  const Pat = policy.contexts.pathList;
  const MOe = policy.pathOwner.contexts.removal;
  const Krt = new AsyncLocalStorage<CheckoutScope>();
  const lwn = new AsyncLocalStorage<ByNameScope>();
  const KSn = new AsyncLocalStorage<boolean>();

  async function Mat<T>(off: boolean, run: () => T | Promise<T>) {
    const state = { off, refused: false, pathListRefused: false };
    return {
      result: await Pat.run(state, run),
      refused: state.refused,
      pathListRefused: state.pathListRefused,
    };
  }

  async function Ekn<T>(run: () => T | Promise<T>) {
    const state: CheckoutScope = {};
    return { result: await Krt.run(state, run), ...state };
  }

  function Rkn(reason: string): boolean {
    const state = Krt.getStore();
    if (state === undefined) return false;
    state.untrustedCheckout ??= reason;
    return true;
  }

  function kOe<T>(run: () => T): T {
    return Krt.run({}, run);
  }

  async function qat<T>(
    run: () => T | Promise<T>,
    { byName = false }: { byName?: boolean } = {},
  ) {
    const state = { refused: false, byName };
    return { verdict: await lwn.run(state, run), refused: state.refused };
  }

  function yMr(): boolean {
    const state = lwn.getStore();
    if (state === undefined) return false;
    if (!state.byName) state.refused = true;
    return state.byName;
  }

  function zOe<T>(divergentRead: boolean, run: () => T): T {
    return KSn.run(divergentRead, run);
  }

  function N6<T>(
    run: () => T,
    state: RemovalScope = MOe.getStore() ?? { ignoreBelowRm: false },
  ): T {
    return MOe.run(state, run);
  }

  /** The native Qv gates invocation itself, without inspecting the removal flag. */
  function Qv<Args extends unknown[]>(
    emit: (...args: Args) => void,
    ...args: Args
  ): void {
    if (MOe.getStore() === undefined) emit(...args);
  }

  return {
    policy,
    contexts: {
      pathList: Pat,
      removal: MOe,
      checkout: Krt,
      byName: lwn,
      divergentRead: KSn,
    },
    native: { Mat, Ekn, Rkn, kOe, qat, yMr, zOe, N6, Qv },
  };
}
