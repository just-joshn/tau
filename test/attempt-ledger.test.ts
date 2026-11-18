import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiAttemptBudget, RequestAttemptLedger } from '../src/attempt-ledger.js';
import { terminalHttpFailure } from '../src/http-error.js';
import { parseOptions } from '../src/options.js';

test('caller allowance survives new query ledgers while retry counts reset', () => {
  const budget = new ApiAttemptBudget(3);
  const first = new RequestAttemptLedger(2, budget);
  first.takeAttempt();
  assert.equal(first.retry(), true); first.takeAttempt();
  assert.equal(first.retriesLeft, 1);
  const next = new RequestAttemptLedger(2, budget);
  assert.equal(next.retriesLeft, 2);
  next.takeAttempt();
  assert.equal(budget.remaining, 0);
  assert.throws(() => next.retry(), /budget exhausted/);
  assert.throws(() => next.takeAttempt(), /budget exhausted/);
  assert.equal(budget.take(), false);
  assert.equal(budget.remaining, 0);
});

test('fallback has one admission even at zero retries and shares retry capacity otherwise', () => {
  const noRetries = new RequestAttemptLedger(0);
  assert.equal(noRetries.retry(), false);
  assert.equal(noRetries.fallback(), true);
  assert.equal(noRetries.fallback(), false);
  assert.equal(noRetries.retriesLeft, 0);
  const normal = new RequestAttemptLedger(2);
  assert.equal(normal.fallback(), true);
  assert.equal(normal.retriesLeft, 1);
  assert.equal(normal.retry(), true);
  assert.equal(normal.retry(), false);
});

test('budget input is bounded, zero is explicit and omission stays unlimited', () => {
  assert.equal(parseOptions([]).maxApiAttempts, undefined);
  for (const count of [0, 1, 1_000_000]) {
    assert.equal(parseOptions(['--max-api-attempts', String(count)]).maxApiAttempts, count);
    assert.equal(new ApiAttemptBudget(count).remaining, count);
  }
  for (const count of [-1, 1.5, Infinity, NaN, 1_000_001]) {
    assert.throws(() => new ApiAttemptBudget(count));
    assert.throws(() => parseOptions(['--max-api-attempts', String(count)]));
  }
  assert.equal(parseOptions([]).allowNonStreamingFallback, true);
  assert.equal(parseOptions(['--allow-nonstream-fallback']).allowNonStreamingFallback, true);
  assert.equal(parseOptions(['--no-nonstream-fallback']).allowNonStreamingFallback, false);
});

test('child allowances charge their parent and stop without taking another shared attempt', () => {
  const parent = new ApiAttemptBudget(3), first = parent.child(1), second = parent.child(5);
  assert.equal(first.take(), true); assert.equal(parent.remaining, 2);
  assert.equal(first.take(), false); assert.equal(parent.remaining, 2);
  assert.equal(second.remaining, 2); assert.equal(second.take(), true); assert.equal(parent.take(), true);
  assert.equal(second.remaining, 0); assert.equal(second.take(), false); assert.equal(parent.remaining, 0);
  const nested = new ApiAttemptBudget(5), child = nested.child(2).child(4);
  assert.equal(child.take(), true); assert.equal(child.take(), true); assert.equal(child.take(), false); assert.equal(nested.remaining, 3);
});

test('billing classification keeps source subscription and fetch-error exceptions', () => {
  const credits = { error: { details: { error_code: 'credits_required' } } };
  assert.equal(terminalHttpFailure(429, new Headers(), credits), true);
  assert.equal(terminalHttpFailure(429, new Headers({ 'anthropic-ratelimit-unified-overage-disabled-reason': 'fetch_error' }), credits), false);
  assert.equal(terminalHttpFailure(429, new Headers({ 'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled_until' }), credits), true);
  const reason = { 'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits' };
  assert.equal(terminalHttpFailure(429, new Headers(reason), undefined), true);
  assert.equal(terminalHttpFailure(429, new Headers({ ...reason, 'anthropic-ratelimit-unified-overage-status': 'allowed' }), undefined), false);
  assert.equal(terminalHttpFailure(429, new Headers(), { error: { message: 'exceeded_limit "overageDisabledReason":"org_service_level_disabled"' } }), true);
  assert.equal(terminalHttpFailure(503, new Headers(reason), credits), false);
});
