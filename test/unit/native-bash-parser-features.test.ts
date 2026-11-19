import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  classifyNativeBashPlainLine,
  createNativeBashParserFeatures,
  type NativeBashFeatureReader,
} from "../../src/native-bash-parser-features.js";

test("parser feature defaults remain enabled with absent, rejected or throwing readers", () => {
  for (const reader of [
    undefined,
    () => ({ value: false, source: "local", defaultHost: true }),
    () => ({ value: false, source: "payload", defaultHost: false }),
    () => {
      throw Error("Unresolved reader");
    },
  ]) {
    const features = createNativeBashParserFeatures(
      reader === undefined
        ? {}
        : {
            keywordReader: reader,
            grammarReader: reader,
            quoteReader: reader,
            misreadingReader: reader,
          },
    );
    assert.equal(features.keywordGuardEnabled(), true);
    assert.equal(features.quotedSubscriptGuardEnabled(), true);
    assert.equal(features.repeatedDollarGuardEnabled(), true);
    assert.equal(features.arithmeticGuardEnabled(), true);
    assert.equal(features.dollarQuoteGuardEnabled(), true);
    assert.equal(features.bracketWordGuardEnabled(), true);
    assert.equal(features.alternateArithmeticRead(), false);
    assert.equal(features.dollarOperandGuardEnabled("echo normal"), false);
  }
});

test("each explicit reader retains its registration scope and strict payload semantics", () => {
  const off: NativeBashFeatureReader = () => ({
    value: false,
    source: "payload",
    defaultHost: true,
  });
  const features = createNativeBashParserFeatures();
  assert.equal(features.registerKeywordReader(off), null);
  assert.equal(features.keywordGuardEnabled(), false);
  assert.equal(features.repeatedDollarGuardEnabled(), true);
  features.registerGrammarReader(off);
  assert.equal(features.repeatedDollarGuardEnabled(), false);
  assert.equal(features.bracketWordGuardEnabled(), true);
  features.registerMisreadingReader(off);
  assert.equal(features.bracketWordGuardEnabled(), false);
  assert.equal(features.quotedSubscriptGuardEnabled(), true);
  features.registerQuoteReader(off);
  assert.equal(features.quotedSubscriptGuardEnabled(), false);
  assert.equal(features.registerKeywordReader(undefined), off);
  assert.equal(features.keywordGuardEnabled(), true);
});

test("grammar readers eagerly inspect their receipt while the general reader preserves short-circuit order", () => {
  const touched: string[] = [];
  const reader: NativeBashFeatureReader = () => ({
    get value() {
      touched.push("value");
      return true;
    },
    get source() {
      touched.push("source");
      return "payload";
    },
    get defaultHost() {
      touched.push("host");
      return true;
    },
  });
  const features = createNativeBashParserFeatures({
    keywordReader: reader,
    grammarReader: reader,
    quoteReader: reader,
    misreadingReader: reader,
  });
  assert.equal(features.keywordGuardEnabled(), true);
  assert.deepEqual(touched.splice(0), ["value", "source", "host"]);
  assert.equal(features.repeatedDollarGuardEnabled(), true);
  assert.deepEqual(touched.splice(0), ["value", "source", "host"]);
  assert.equal(features.quotedSubscriptGuardEnabled(), true);
  assert.deepEqual(touched.splice(0), ["value", "source", "host"]);
  assert.equal(features.bracketWordGuardEnabled(), true);
  assert.deepEqual(touched, ["value"]);
});

test("keyword guard observation keeps fired state through awaits and restores its parent", async () => {
  const features = createNativeBashParserFeatures();
  const observed = await features.observeKeywordGuard(false, async () => {
    assert.equal(features.keywordGuardOff(), false);
    await Promise.resolve();
    const nested = await features.observeKeywordGuard(true, async () => {
      features.markKeywordDesynchronization();
      await Promise.resolve();
      assert.equal(features.keywordGuardOff(), true);
      return "nested";
    });
    assert.deepEqual(nested, { result: "nested", fired: true });
    return "parent";
  });
  assert.deepEqual(observed, { result: "parent", fired: false });
  assert.equal(features.keywordGuardOff(), false);
  assert.equal(
    features.withoutKeywordGuard(() => features.keywordGuardOff()),
    true,
  );
});

test("independent asynchronous divergence observers cannot leak into each other", async () => {
  const features = createNativeBashParserFeatures();
  const [marked, clear] = await Promise.all([
    features.observeMayDiffer(async () => {
      await Promise.resolve();
      features.markMayDiffer();
      return 1;
    }),
    features.observeMayDiffer(async () => {
      await Promise.resolve();
      return 2;
    }),
  ]);
  assert.deepEqual(marked, { result: 1, mayDiffer: true });
  assert.deepEqual(clear, { result: 2, mayDiffer: false });
});

test("arithmetic and operand alternate-read contexts restore source guard state", () => {
  const features = createNativeBashParserFeatures();
  assert.equal(features.arithmeticGuardEnabled(), true);
  features.withoutArithmeticGuard(() => {
    assert.equal(features.arithmeticGuardEnabled(), false);
    features.withAlternateArithmeticRead(() =>
      assert.equal(features.alternateArithmeticRead(), true),
    );
    assert.equal(features.alternateArithmeticRead(), false);
  });
  assert.equal(features.arithmeticGuardEnabled(), true);
  assert.equal(features.dollarOperandGuardEnabled("echo $$[x]"), true);
  assert.equal(
    features.withoutDollarOperandGuard(() =>
      features.dollarOperandGuardEnabled("echo $$[x]"),
    ),
    false,
  );
  features.withInputReadGuards("echo $((1)) $$[x]", () => {
    assert.equal(features.arithmeticGuardEnabled(), false);
    assert.equal(features.dollarOperandGuardEnabled("echo $$[x]"), false);
  });
  assert.equal(features.arithmeticGuardEnabled(), true);
});

test("misreading scopes retain the first reason while suppression and reader controls stay separate", async () => {
  const features = createNativeBashParserFeatures();
  assert.equal(features.readMisreading("words_after_test"), "words_after_test");
  const observed = await features.observeMisreading(async () => {
    assert.equal(features.readMisreading("words_after_test"), undefined);
    await Promise.resolve();
    features.readMisreading("hash_in_test");
    return "done";
  });
  assert.deepEqual(observed, {
    result: "done",
    misreading: "words_after_test",
  });
  assert.equal(
    features.withoutMisreading(() => features.readMisreading("hash_in_test")),
    undefined,
  );
  assert.equal(
    features.withoutMisreading(() => features.semanticReadGuardEnabled()),
    false,
  );
  assert.equal(features.semanticReadGuardEnabled(), true);
  assert.equal(features.inputMisreading("echo $~name"), "pattern_flag");
});

test("the optional plain-line exemption requires an admitted true reader result", () => {
  const input = "echo '$$('";
  assert.equal(classifyNativeBashPlainLine(input), undefined);
  const features = createNativeBashParserFeatures();
  assert.equal(features.dollarOperandGuardEnabled(input), true);
  features.registerGrammarReader((key, fallback) => ({
    value: key === "tengu_moonlit_crayon" ? true : fallback,
    source: "payload",
    defaultHost: true,
  }));
  assert.equal(features.dollarOperandGuardEnabled(input), false);
  assert.equal(features.dollarOperandGuardEnabled("printf '$$('"), true);
});

test("plain-line classifier handles its finite heads, comments, quotes and quoted heredocs", () => {
  for (const input of [
    "echo text",
    "# owned comment\necho 'literal'",
    "cat <<'END'\nowned body\nEND\n",
    "echo text; cat file",
  ])
    assert.equal(classifyNativeBashPlainLine(input), undefined, input);
  for (const [input, reason] of [
    ["printf text", "head_script_tool"],
    ["curl example", "head_fetch"],
    ["FOO=x echo text", "head_assignment"],
    ["echo 'open", "open_quote"],
    ["cat <<'END'\nmissing", "open_heredoc"],
    ["echo \u0007", "control_byte"],
    ["echo text; printf next", "head_script_tool"],
  ])
    assert.equal(classifyNativeBashPlainLine(input ?? ""), reason, input ?? "");
});

test("source guard-off getters read only their own ALS scope through nesting, rejection and concurrent awaits", async () => {
  let readerCalls = 0;
  const features = createNativeBashParserFeatures({
    grammarReader: () => {
      readerCalls++;
      throw Error("The guard-off getters must not read feature configuration");
    },
  });
  const state = () => [
    features.arithmeticGuardOff(),
    features.dollarOperandGuardOff(),
  ];
  assert.deepEqual(state(), [false, false]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const arithmetic = features.withoutArithmeticGuard(async () => {
    assert.deepEqual(state(), [true, false]);
    await features.withoutDollarOperandGuard(async () => {
      assert.deepEqual(state(), [true, true]);
      entered.resolve();
      await release.promise;
      assert.deepEqual(state(), [true, true]);
    });
    assert.deepEqual(state(), [true, false]);
  });
  await entered.promise;
  assert.deepEqual(state(), [false, false]);
  await features.withoutDollarOperandGuard(async () => {
    await Promise.resolve();
    assert.deepEqual(state(), [false, true]);
  });
  assert.deepEqual(state(), [false, false]);
  release.resolve();
  await arithmetic;
  await assert.rejects(
    features.withoutDollarOperandGuard(() =>
      features.withoutArithmeticGuard(async () => {
        await Promise.resolve();
        assert.deepEqual(state(), [true, true]);
        throw Error("restore the outer context");
      }),
    ),
    /restore the outer context/,
  );
  assert.deepEqual(state(), [false, false]);
  assert.equal(readerCalls, 0);
});

test("separate dollar feature and exemption getters preserve native reader order and strict payload defaults", () => {
  const absent = createNativeBashParserFeatures();
  assert.equal(absent.dollarOperandFeatureEnabled(), true);
  assert.equal(absent.plainLineExemptionEnabled(), false);
  const calls: string[] = [];
  const features = createNativeBashParserFeatures({
    grammarReader: (key, fallback) => {
      calls.push(`${key}:${fallback}`);
      return {
        get value() {
          calls.push("value");
          return false;
        },
        get source() {
          calls.push("source");
          return "local";
        },
        get defaultHost() {
          calls.push("host");
          return true;
        },
      };
    },
  });
  assert.equal(features.dollarOperandFeatureEnabled(), true);
  assert.deepEqual(calls.splice(0), [
    "tengu_deep_locket:true",
    "value",
    "source",
    "host",
  ]);
  assert.equal(features.plainLineExemptionEnabled(), false);
  assert.deepEqual(calls.splice(0), ["tengu_moonlit_crayon:false", "value"]);
  features.registerGrammarReader((key, fallback) => {
    calls.push(`${key}:${fallback}`);
    return {
      value: key === "tengu_moonlit_crayon",
      source: "payload",
      defaultHost: true,
    };
  });
  assert.equal(features.dollarOperandFeatureEnabled(), false);
  assert.equal(features.plainLineExemptionEnabled(), true);
  for (const reader of [
    () => ({ value: true, source: "local", defaultHost: true }),
    () => ({ value: true, source: "payload", defaultHost: false }),
    () => {
      throw Error("authored missing reader");
    },
  ]) {
    features.registerGrammarReader(reader);
    assert.equal(features.dollarOperandFeatureEnabled(), true);
    assert.equal(features.plainLineExemptionEnabled(), false);
  }
});

test("dollar feature getter observes its own async guard while exemption remains independent", async () => {
  const calls: string[] = [];
  const features = createNativeBashParserFeatures({
    grammarReader: (key) => {
      calls.push(key);
      return { value: true, source: "payload", defaultHost: true };
    },
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const guarded = features.withoutDollarOperandGuard(async () => {
    assert.equal(features.dollarOperandFeatureEnabled(), false);
    assert.deepEqual(calls.splice(0), []);
    entered.resolve();
    await release.promise;
    assert.equal(features.dollarOperandFeatureEnabled(), false);
    assert.equal(features.plainLineExemptionEnabled(), true);
  });
  await entered.promise;
  assert.equal(features.dollarOperandFeatureEnabled(), true);
  assert.deepEqual(calls.splice(0), ["tengu_deep_locket"]);
  release.resolve();
  await guarded;
  assert.deepEqual(calls.splice(0), ["tengu_moonlit_crayon"]);
  await assert.rejects(
    features.withoutDollarOperandGuard(async () => {
      await Promise.resolve();
      assert.equal(features.dollarOperandFeatureEnabled(), false);
      throw Error("restore separate native getter context");
    }),
    /restore separate native getter context/,
  );
  assert.equal(features.dollarOperandFeatureEnabled(), true);
  assert.deepEqual(calls, ["tengu_deep_locket"]);
});

test("native O3a observes may-differ scope presence independently from its mutable answer", async () => {
  const features = createNativeBashParserFeatures();
  expect(features.hasMayDifferObservation()).toBe(false);
  const outer = await features.observeMayDiffer(async () => {
    expect(features.hasMayDifferObservation()).toBe(true);
    const inner = await features.observeMayDiffer(() => {
      expect(features.hasMayDifferObservation()).toBe(true);
      features.markMayDiffer();
      return "nested";
    });
    expect(inner).toEqual({ result: "nested", mayDiffer: true });
    expect(features.hasMayDifferObservation()).toBe(true);
    return "outer";
  });
  expect(outer).toEqual({ result: "outer", mayDiffer: false });
  expect(features.hasMayDifferObservation()).toBe(false);
});

test("native O3a presence stays private to its retained feature owner and restores after rejection", async () => {
  const features = createNativeBashParserFeatures();
  const independent = createNativeBashParserFeatures();
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failure = new Error("authored may-differ failure");
  const pending = features.observeMayDiffer(async () => {
    expect(features.hasMayDifferObservation()).toBe(true);
    expect(independent.hasMayDifferObservation()).toBe(false);
    await wait;
    expect(features.hasMayDifferObservation()).toBe(true);
    throw failure;
  });
  expect(features.hasMayDifferObservation()).toBe(false);
  const rejection = assert.rejects(pending, (error) => error === failure);
  release();
  await rejection;
  expect(features.hasMayDifferObservation()).toBe(false);
  expect(independent.hasMayDifferObservation()).toBe(false);
});
