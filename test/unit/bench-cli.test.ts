import { expect, test } from "bun:test";
import {
  regressions,
  summarize,
  type Report,
} from "../../scripts/bench/cli.js";

test("summarize reports nearest-rank median and p90, spread and peak RSS", () => {
  const samples = [50, 10, 40, 20, 30].map((ms) => ({
    ms,
    rssBytes: ms * 1000,
  }));
  expect(summarize(samples)).toEqual({
    runs: 5,
    medianMs: 30,
    p90Ms: 50,
    minMs: 10,
    maxMs: 50,
    spreadMs: 40,
    peakRssBytes: 50_000,
    medianRssBytes: 30_000,
  });
});

function report(medians: Record<string, number>): Report {
  return {
    schemaVersion: 1,
    createdAt: "2026-11-17T00:00:00.000Z",
    warmup: 0,
    metadata: {
      runtime: "bun 1.4.4",
      platform: "linux",
      arch: "x64",
      cpus: 4,
      cpuModel: "test",
      loadavgAtStart: [0, 0, 0],
      gitSha: "abc",
    },
    scenarios: Object.fromEntries(
      Object.entries(medians).map(([name, medianMs]) => [
        name,
        summarize([{ ms: medianMs, rssBytes: 1 }]),
      ]),
    ),
  };
}

test("regression gate flags only medians that grew past the budget", () => {
  const baseline = report({ start: 100, roundtrip: 200, retired: 10 });
  const current = report({ start: 111, roundtrip: 210, added: 999 });
  const [flagged, ...rest] = regressions(baseline, current, 0.1);
  expect(rest).toEqual([]);
  expect(flagged?.scenario).toBe("start");
  expect(flagged?.change).toBeCloseTo(0.11, 6);
  expect(regressions(baseline, current, 0.2)).toEqual([]);
});
