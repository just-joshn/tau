import { expect, test } from "bun:test";
import { createNativeBashCommandPreparation } from "../../src/native-bash-command-preparation.js";
import { createNativeBashSecurityPolicyControl } from "../../src/native-bash-security/policy-control.js";
import { createNativeBashSecurityObservations } from "../../src/native-bash-security/security-observations.js";
import { fixture } from "./security-fixture.js";

function owner() {
  const f = fixture();
  const prep = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const policy = createNativeBashSecurityPolicyControl(
    f.semantic,
    prep,
    f.host,
  );
  return createNativeBashSecurityObservations(policy);
}

test("checkout observations retain first reason, suppress nested reads and isolate concurrent passes", async () => {
  const o = owner();
  const { Ekn, Rkn, kOe } = o.native;
  expect(Rkn("outside")).toBe(false);
  const results = await Promise.all(
    ["first", "second"].map((reason) =>
      Ekn(async () => {
        await Promise.resolve();
        expect(Rkn(reason)).toBe(true);
        expect(Rkn("replacement")).toBe(true);
        await kOe(async () => {
          Rkn("hidden");
          await Promise.resolve();
          expect(o.contexts.checkout.getStore()?.untrustedCheckout).toBe(
            "hidden",
          );
        });
        return reason;
      }),
    ),
  );
  expect(results).toEqual([
    { result: "first", untrustedCheckout: "first" },
    { result: "second", untrustedCheckout: "second" },
  ]);
  expect(await Ekn(() => 7)).toEqual({ result: 7 });
  expect(o.contexts.checkout.getStore()).toBeUndefined();
});

test("by-name scope distinguishes an observed refusal from an ordinary false result", async () => {
  const o = owner();
  expect(o.native.yMr()).toBe(false);
  expect(await o.native.qat(() => false)).toEqual({
    verdict: false,
    refused: false,
  });
  expect(await o.native.qat(o.native.yMr)).toEqual({
    verdict: false,
    refused: true,
  });
  expect(
    await o.native.qat(async () => {
      expect(await o.native.qat(o.native.yMr, { byName: true })).toEqual({
        verdict: true,
        refused: false,
      });
      return o.native.yMr();
    }),
  ).toEqual({ verdict: false, refused: true });
  expect(o.contexts.byName.getStore()).toBeUndefined();
});

test("path-list observations share the actual policy owner and remain distinct", async () => {
  const o = owner();
  expect(o.contexts.pathList).toBe(o.policy.contexts.pathList);
  expect(
    await o.native.Mat(false, async () => {
      const outer = o.policy.contexts.pathList.getStore();
      if (!outer) throw new Error("scope missing");
      outer.refused = true;
      expect(
        await o.native.Mat(true, () => o.contexts.pathList.getStore()?.off),
      ).toEqual({ result: true, refused: false, pathListRefused: false });
      outer.pathListRefused = true;
      return "observed";
    }),
  ).toEqual({ result: "observed", refused: true, pathListRefused: true });
  expect(o.contexts.pathList.getStore()).toBeUndefined();
});

test("counterfactual telemetry suppression depends on scope presence, preserving native removal flags", async () => {
  const o = owner();
  const rows: string[] = [];
  const emit = (row: string) => {
    rows.push(row);
  };
  o.native.Qv(emit, "before");
  await o.native.N6(async () => {
    const state = o.contexts.removal.getStore();
    expect(state).toEqual({ ignoreBelowRm: false });
    o.native.Qv(emit, "false-still-suppresses");
    await o.native.N6(async () => {
      expect(o.contexts.removal.getStore()).toBe(state);
      await Promise.resolve();
      o.native.Qv(emit, "nested");
    });
    o.native.N6(
      () => {
        expect(o.contexts.removal.getStore()?.ignoreBelowRm).toBe(true);
      },
      { ignoreBelowRm: true },
    );
    expect(o.contexts.removal.getStore()).toBe(state);
  });
  o.native.Qv(emit, "after");
  expect(rows).toEqual(["before", "after"]);
});

test("divergent-read and rejection scopes restore without changing sibling observations", async () => {
  const o = owner();
  const fail = new Error("author rejection");
  let caught: unknown;
  try {
    await o.native.zOe(true, () =>
      o.native.Ekn(() =>
        o.native.qat(() =>
          o.native.Mat(false, () =>
            o.native.N6(async () => {
              expect(o.contexts.divergentRead.getStore()).toBe(true);
              await o.native.zOe(false, async () => {
                await Promise.resolve();
                expect(o.contexts.divergentRead.getStore()).toBe(false);
              });
              expect(o.contexts.divergentRead.getStore()).toBe(true);
              throw fail;
            }),
          ),
        ),
      ),
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(fail);
  for (const scope of Object.values(o.contexts))
    expect(scope.getStore()).toBeUndefined();
});
