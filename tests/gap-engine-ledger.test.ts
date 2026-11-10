/**
 * Tests for the gap ledger rules: evidence, importance floor, budget and
 * displacement, duplicates across statuses, cooldown, staleness, resolve
 * flow and user actions. These are the product's precision guarantees.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GapLedger, type LedgerOptions } from '../src/core/gap-engine/ledger';
import { parseModelOutput } from '../src/core/gap-engine/operations';
import { TranscriptIndex } from '../src/core/gap-engine/text';
import type { GapEvent } from '../src/core/gap-engine/types';

const transcript = new TranscriptIndex();
[
  ['them', 'Archived projects should be hidden from everyone.', 0],
  ['them', 'Refunds are instant for every customer.', 10_000],
  ['them', 'Finance approves any refund over five hundred dollars.', 20_000],
  ['them', 'Imports can be up to fifty thousand contacts with dedupe.', 30_000],
  ['them', 'The nightly sync job picks up the changes.', 40_000],
  ['them', 'Hidden means hidden from search results only, the list still shows them.', 50_000],
].forEach(([speaker, text, startMs]) =>
  transcript.add({ speaker: speaker as string, text: text as string, startMs: startMs as number, endMs: (startMs as number) + 5000 }),
);
const find = (quote: string) => transcript.find(quote);

const QUOTES = {
  archived: 'Archived projects should be hidden',
  refundsInstant: 'Refunds are instant for every customer',
  finance: 'Finance approves any refund over five hundred dollars',
  imports: 'up to fifty thousand contacts with dedupe',
  sync: 'The nightly sync job picks up the changes',
  answer: 'hidden from search results only',
};

function raise(question: string, importance: number, quote: string, kind = 'ambiguity') {
  return { kind, question, why: 'changes what gets built', evidence: [{ speaker: 'them', quote }], importance };
}

function run(ledger: GapLedger, output: Record<string, unknown>, nowMs: number) {
  return ledger.apply(parseModelOutput(output), nowMs, find);
}

function newLedger(options: Partial<LedgerOptions> = {}) {
  return new GapLedger({ raiseCooldownMs: 0, ...options });
}

test('accepts a well-evidenced raise and records verified evidence', () => {
  const ledger = newLedger();
  const result = run(ledger, { raise: [raise('Hidden from search only, or also from the project list?', 4, QUOTES.archived)] }, 1000);
  assert.equal(result.accepted.length, 1);
  const item = ledger.get('g1');
  assert.ok(item);
  assert.equal(item.status, 'open');
  assert.equal(item.raisedAtMs, 1000);
  assert.deepEqual(item.evidence, [{ speaker: 'them', quote: QUOTES.archived, atMs: 0 }]);
});

test('drops a raise whose quote is invented', () => {
  const ledger = newLedger();
  const result = run(ledger, { raise: [raise('Must exports be encrypted?', 5, 'exports must be encrypted at rest')] }, 1000);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, 'evidence_not_found');
  assert.equal(ledger.all().length, 0);
});

test('keeps a raise with one verified quote and drops its unverifiable quotes', () => {
  const ledger = newLedger();
  const op = raise('Are refunds over $500 instant or held?', 5, QUOTES.refundsInstant, 'contradiction');
  op.evidence.push({ speaker: 'them', quote: 'refunds wait for the CFO every time' });
  const result = run(ledger, { raise: [op] }, 1000);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(
    ledger.get('g1')?.evidence.map((evidence) => evidence.quote),
    [QUOTES.refundsInstant],
  );
});

test('drops raises below the importance floor', () => {
  const ledger = newLedger();
  const result = run(ledger, { raise: [raise('Hidden from search only?', 2, QUOTES.archived)] }, 1000);
  assert.equal(result.rejected[0].reason, 'below_importance_floor');
  const custom = newLedger({ importanceFloor: 2 });
  assert.equal(run(custom, { raise: [raise('Hidden from search only?', 2, QUOTES.archived)] }, 1000).accepted.length, 1);
});

test('accepts at most maxRaisesPerRun raises per run, preferring the most important', () => {
  const ledger = newLedger();
  const result = run(
    ledger,
    {
      raise: [
        raise('Hidden from search only, or the list too?', 3, QUOTES.archived),
        raise('Are refunds over $500 instant or held for finance?', 5, QUOTES.finance, 'contradiction'),
      ],
    },
    1000,
  );
  assert.equal(result.accepted.length, 1);
  assert.equal(ledger.get('g1')?.importance, 5);
  assert.equal(result.rejected[0].reason, 'max_raises_per_run');
});

test('budget: a full ledger only admits a raise that out-ranks the weakest open item', () => {
  const ledger = newLedger({ maxOpen: 2 });
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 1000);
  run(ledger, { raise: [raise('Are refunds over $500 instant or held for finance?', 4, QUOTES.finance, 'contradiction')] }, 2000);

  const tooWeak = run(ledger, { raise: [raise('Do duplicate contacts merge, skip, or duplicate?', 3, QUOTES.imports, 'unaddressed')] }, 3000);
  assert.equal(tooWeak.rejected[0].reason, 'over_budget');
  assert.equal(ledger.snapshot().open.length, 2);

  const stronger = run(ledger, { raise: [raise('Do duplicate contacts merge, skip, or duplicate?', 5, QUOTES.imports, 'unaddressed')] }, 4000);
  assert.equal(stronger.accepted[0].displacedId, 'g1');
  const displaced = ledger.get('g1');
  assert.equal(displaced?.status, 'expired');
  assert.equal(displaced?.expiredReason, 'displaced');
  assert.deepEqual(
    ledger.snapshot().open.map((item) => item.id),
    ['g3', 'g2'],
  );
});

test('budget: on equal importance the least recently touched item is displaced', () => {
  const ledger = newLedger({ maxOpen: 2 });
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 1000);
  run(ledger, { raise: [raise('Are refunds over $500 instant or held for finance?', 3, QUOTES.finance, 'contradiction')] }, 2000);
  run(ledger, { raise: [raise('Do duplicate contacts merge, skip, or duplicate?', 4, QUOTES.imports, 'unaddressed')] }, 3000);
  assert.equal(ledger.get('g1')?.status, 'expired');
  assert.equal(ledger.get('g2')?.status, 'open');
});

test('duplicate guard rejects a reworded raise of an open item', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Are archived projects hidden from search only, or from the project list too?', 4, QUOTES.archived)] }, 1000);
  const result = run(ledger, { raise: [raise('Hidden archived projects: from search, or from the project list too?', 4, QUOTES.archived)] }, 2000);
  assert.equal(result.rejected[0].reason, 'duplicate');
  assert.match(result.rejected[0].detail ?? '', /g1 \(open/);
});

test('duplicate guard: dismissed items never come back', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Are archived projects hidden from search only, or the project list too?', 4, QUOTES.archived)] }, 1000);
  assert.equal(ledger.dismiss('g1', 1500), true);
  const result = run(ledger, { raise: [raise('Archived projects hidden from search only, or project list too?', 5, QUOTES.archived)] }, 2000);
  assert.equal(result.rejected[0].reason, 'duplicate');
  assert.match(result.rejected[0].detail ?? '', /dismissed/);
});

test('duplicate guard covers resolved and expired items', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Are archived projects hidden from search only, or the project list too?', 4, QUOTES.archived)] }, 1000);
  run(ledger, { resolve: [{ id: 'g1', how: 'Search only', evidence: { speaker: 'them', quote: QUOTES.answer } }] }, 2000);
  const again = run(ledger, { raise: [raise('Archived projects hidden from search or the project list too?', 4, QUOTES.archived)] }, 3000);
  assert.equal(again.rejected[0].reason, 'duplicate');

  run(ledger, { raise: [raise('Are refunds over $500 instant or held for finance?', 4, QUOTES.finance)] }, 4000);
  run(ledger, { drop: [{ id: 'g2', reason: 'refunds feature cut' }] }, 5000);
  const dropped = run(ledger, { raise: [raise('Refunds over $500: instant, or held for finance?', 4, QUOTES.finance)] }, 6000);
  assert.equal(dropped.rejected[0].reason, 'duplicate');
});

test('cooldown blocks a second raise soon after the first, except at importance 5', () => {
  const ledger = new GapLedger({ raiseCooldownMs: 60_000 });
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 0);
  const blocked = run(ledger, { raise: [raise('Do duplicate contacts merge, skip, or duplicate?', 4, QUOTES.imports, 'unaddressed')] }, 30_000);
  assert.equal(blocked.rejected[0].reason, 'cooldown');

  const urgent = run(ledger, { raise: [raise('Are refunds over $500 instant or held for finance?', 5, QUOTES.finance, 'contradiction')] }, 40_000);
  assert.equal(urgent.accepted.length, 1);

  // The cooldown restarts from the importance-5 raise.
  const stillBlocked = run(ledger, { raise: [raise('Do duplicate contacts merge, skip, or duplicate?', 4, QUOTES.imports, 'unaddressed')] }, 90_000);
  assert.equal(stillBlocked.rejected[0].reason, 'cooldown');
  const later = run(ledger, { raise: [raise('Do duplicate contacts merge, skip, or duplicate?', 4, QUOTES.imports, 'unaddressed')] }, 100_000);
  assert.equal(later.accepted.length, 1);
});

test('staleness expires open items that nobody touched', () => {
  const ledger = new GapLedger({ raiseCooldownMs: 0, staleAfterMs: 12 * 60_000 });
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 0);
  run(ledger, { raise: [raise('Are refunds over $500 instant or held for finance?', 4, QUOTES.finance)] }, 5 * 60_000);
  assert.deepEqual(ledger.expireStale(11 * 60_000), []);
  run(ledger, { update: [{ id: 'g1', importance: 4, question: null, why: null }] }, 11 * 60_000);
  assert.deepEqual(ledger.expireStale(17 * 60_000), ['g2']);
  assert.equal(ledger.get('g2')?.expiredReason, 'stale');
  assert.equal(ledger.get('g1')?.status, 'open');
  assert.deepEqual(ledger.expireStale(23 * 60_000), ['g1']);
});

test('resolve flow: verified answer resolves; unverified answer is rejected', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 4, QUOTES.archived)] }, 1000);

  const invented = run(ledger, { resolve: [{ id: 'g1', how: 'Hidden everywhere', evidence: { speaker: 'them', quote: 'hidden from absolutely everything everywhere' } }] }, 2000);
  assert.equal(invented.rejected[0].reason, 'evidence_not_found');
  assert.equal(ledger.get('g1')?.status, 'open');

  const resolved = run(ledger, { resolve: [{ id: 'g1', how: 'Search only; the list still shows them', evidence: { speaker: 'them', quote: QUOTES.answer } }] }, 3000);
  assert.equal(resolved.accepted.length, 1);
  const item = ledger.get('g1');
  assert.equal(item?.status, 'resolved');
  assert.equal(item?.resolution?.how, 'Search only; the list still shows them');
  assert.equal(item?.resolution?.evidence[0].atMs, 50_000);
  assert.equal(ledger.snapshot().resolved[0].id, 'g1');
  assert.equal(ledger.snapshot().open.length, 0);
});

test('resolving frees budget for a raise in the same run', () => {
  const ledger = newLedger({ maxOpen: 1 });
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 4, QUOTES.archived)] }, 1000);
  const result = run(
    ledger,
    {
      raise: [raise('Do duplicate contacts merge, skip, or duplicate?', 3, QUOTES.imports, 'unaddressed')],
      resolve: [{ id: 'g1', how: 'Search only', evidence: { speaker: 'them', quote: QUOTES.answer } }],
    },
    2000,
  );
  assert.equal(result.accepted.length, 2);
  assert.equal(ledger.get('g2')?.status, 'open');
});

test('ops on unknown or closed items are rejected', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 4, QUOTES.archived)] }, 1000);
  ledger.dismiss('g1', 1500);
  const result = run(
    ledger,
    {
      resolve: [{ id: 'g9', how: 'x', evidence: { speaker: 'them', quote: QUOTES.answer } }],
      update: [{ id: 'g1', question: 'Sharper?', why: null, importance: null }],
      drop: [{ id: 'g1', reason: 'moot' }],
    },
    2000,
  );
  assert.deepEqual(
    result.rejected.map((r) => r.reason),
    ['unknown_id', 'not_open', 'not_open'],
  );
});

test('update sharpens an item; a no-op update is rejected', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 1000);
  const updated = run(ledger, { update: [{ id: 'g1', question: 'Hidden from search, the list, or shared links?', why: null, importance: 4 }] }, 2000);
  assert.equal(updated.accepted.length, 1);
  const item = ledger.get('g1');
  assert.equal(item?.question, 'Hidden from search, the list, or shared links?');
  assert.equal(item?.importance, 4);
  assert.equal(item?.why, 'changes what gets built');
  assert.equal(item?.updatedAtMs, 2000);

  const noop = run(ledger, { update: [{ id: 'g1', importance: 4 }] }, 3000);
  assert.equal(noop.rejected[0].reason, 'empty_update');
});

test('drop expires an item with the model reason', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 1000);
  run(ledger, { drop: [{ id: 'g1', reason: 'archiving was cut from scope' }] }, 2000);
  assert.equal(ledger.get('g1')?.status, 'expired');
  assert.equal(ledger.get('g1')?.expiredReason, 'moot: archiving was cut from scope');
});

test('user actions: dismiss, restore and markResolved', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 1000);
  assert.equal(ledger.markResolved('g9', 1100), false);
  assert.equal(ledger.restore('g1', 1100), false, 'already open');

  assert.equal(ledger.dismiss('g1', 1200), true);
  assert.equal(ledger.get('g1')?.status, 'dismissed');
  assert.equal(ledger.dismiss('g1', 1300), false);

  assert.equal(ledger.restore('g1', 1400), true);
  assert.equal(ledger.get('g1')?.status, 'open');
  assert.equal(ledger.get('g1')?.updatedAtMs, 1400);

  assert.equal(ledger.markResolved('g1', 1500), true);
  assert.equal(ledger.get('g1')?.status, 'resolved');
  assert.equal(ledger.get('g1')?.resolution?.how, 'Marked resolved by the user');

  assert.equal(ledger.restore('g1', 1600), true);
  assert.equal(ledger.get('g1')?.resolution, undefined);
});

test('every state change emits an event with a full snapshot', () => {
  const ledger = new GapLedger({ raiseCooldownMs: 0, maxOpen: 1 });
  const events: GapEvent[] = [];
  ledger.subscribe((event) => events.push(event));

  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)], bigIdeas: ['Archiving hides projects'] }, 1000);
  run(ledger, { raise: [raise('Are refunds over $500 instant or held for finance?', 5, QUOTES.finance)] }, 2000);
  run(ledger, { bigIdeas: ['Archiving hides projects'] }, 2500);
  ledger.dismiss('g2', 3000);

  assert.deepEqual(
    events.map((e) => [e.type, e.itemId]),
    [
      ['raised', 'g1'],
      ['big_ideas', undefined],
      ['expired', 'g1'],
      ['raised', 'g2'],
      ['dismissed', 'g2'],
    ],
  );
  const raisedG2 = events[3];
  assert.deepEqual(
    raisedG2.snapshot.open.map((item) => item.id),
    ['g2'],
  );
  assert.deepEqual(raisedG2.snapshot.bigIdeas, ['Archiving hides projects']);
  assert.equal(events[4].snapshot.open.length, 0);
});

test('an empty bigIdeas reply keeps the current list instead of wiping it', () => {
  const ledger = newLedger();
  run(ledger, { bigIdeas: ['Archiving hides projects'] }, 1000);
  const result = run(ledger, { raise: [], resolve: [], update: [], drop: [], bigIdeas: [] }, 2000);
  assert.deepEqual(ledger.getBigIdeas(), ['Archiving hides projects']);
  assert.equal(result.accepted.length, 0);
  run(ledger, { bigIdeas: ['Refunds need finance approval'] }, 3000);
  assert.deepEqual(ledger.getBigIdeas(), ['Refunds need finance approval']);
});

test('a throwing listener does not break the ledger', () => {
  const ledger = newLedger();
  ledger.subscribe(() => {
    throw new Error('UI bug');
  });
  const result = run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 1000);
  assert.equal(result.accepted.length, 1);
});

test('snapshots are copies that callers cannot use to mutate the ledger', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 1000);
  ledger.snapshot().open[0].status = 'dismissed';
  assert.equal(ledger.get('g1')?.status, 'open');
});

test('update cannot reword an open item into the question of another item', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Which timezone does the 5pm cutoff use?', 4, QUOTES.archived)] }, 1000);
  ledger.dismiss('g1', 1500);
  run(ledger, { raise: [raise('Do partial shipments count against the order limit?', 4, QUOTES.imports, 'unaddressed')] }, 2000);
  const result = run(ledger, { update: [{ id: 'g2', question: 'Which timezone does the 5pm cutoff use?', why: null, importance: null }] }, 3000);
  assert.equal(result.rejected[0].reason, 'duplicate');
  assert.match(result.rejected[0].detail ?? '', /g1 \(dismissed/);
  assert.equal(ledger.get('g2')?.question, 'Do partial shipments count against the order limit?');
  assert.equal(ledger.get('g2')?.updatedAtMs, 2000);
});

test('duplicate guard: a paraphrase quoting the same statement is a duplicate in every closed status', () => {
  const paraphrase = () => raise('Should the cutoff be evaluated in local time or UTC?', 4, QUOTES.archived);
  const original = () => raise('Which timezone does the 5pm cutoff use?', 4, QUOTES.archived);

  const dismissed = newLedger();
  run(dismissed, { raise: [original()] }, 1000);
  dismissed.dismiss('g1', 1500);
  const again = run(dismissed, { raise: [paraphrase()] }, 2000);
  assert.equal(again.rejected[0].reason, 'duplicate');
  assert.match(again.rejected[0].detail ?? '', /same evidence as g1 \(dismissed\)/);

  const resolved = newLedger();
  run(resolved, { raise: [original()] }, 1000);
  run(resolved, { resolve: [{ id: 'g1', how: 'Search only', evidence: { speaker: 'them', quote: QUOTES.answer } }] }, 2000);
  assert.equal(run(resolved, { raise: [paraphrase()] }, 3000).rejected[0].reason, 'duplicate');

  const expired = new GapLedger({ raiseCooldownMs: 0, staleAfterMs: 60_000 });
  run(expired, { raise: [original()] }, 0);
  expired.expireStale(60_000);
  assert.equal(run(expired, { raise: [paraphrase()] }, 70_000).rejected[0].reason, 'duplicate');
});

test('duplicate guard keeps apart distinct gaps quoting different parts of one long segment', () => {
  const long = new TranscriptIndex();
  long.add({
    speaker: 'them',
    text: 'Refunds over five hundred dollars need finance approval, and partial shipments are billed when the last box leaves the warehouse.',
    startMs: 0,
    endMs: 9000,
  });
  const ledger = newLedger();
  const apply = (output: Record<string, unknown>, nowMs: number) => ledger.apply(parseModelOutput(output), nowMs, (quote) => long.find(quote));
  apply({ raise: [raise('Who in finance approves large refunds?', 4, 'Refunds over five hundred dollars need finance approval')] }, 1000);
  const second = apply(
    { raise: [raise('Is a partial shipment billed per box or once?', 4, 'partial shipments are billed when the last box leaves', 'unaddressed')] },
    2000,
  );
  assert.equal(second.accepted.length, 1);
});

test('duplicate guard: a different kind of gap built on one side of a contradiction is new', () => {
  const ledger = newLedger();
  const contradiction = raise('Are refunds over $500 instant or held for finance?', 5, QUOTES.refundsInstant, 'contradiction');
  contradiction.evidence.push({ speaker: 'them', quote: QUOTES.finance });
  run(ledger, { raise: [contradiction] }, 1000);
  const unaddressed = run(ledger, { raise: [raise('Who approves when finance is away?', 4, QUOTES.finance, 'unaddressed')] }, 2000);
  assert.equal(unaddressed.accepted.length, 1);
  const sameKind = run(ledger, { raise: [raise('Do finance approvals block instant refunds?', 4, QUOTES.finance, 'contradiction')] }, 3000);
  assert.equal(sameKind.rejected[0].reason, 'duplicate');
});

test('a retired unanswered gap raised again from new speech is reopened, not duplicated', () => {
  const ledger = new GapLedger({ raiseCooldownMs: 0, staleAfterMs: 60_000 });
  run(ledger, { raise: [raise('Are archived projects hidden from search only, or the project list too?', 4, QUOTES.archived)] }, 0);
  ledger.expireStale(60_000);
  assert.deepEqual(
    ledger.snapshot().unanswered.map((item) => item.id),
    ['g1'],
  );

  const sameSpeech = run(ledger, { raise: [raise('Archived projects hidden from search only, or project list too?', 4, QUOTES.archived)] }, 70_000);
  assert.equal(sameSpeech.rejected[0].reason, 'duplicate', 'nothing new was said');

  const result = run(ledger, { raise: [raise('Archived projects hidden from search only, or project list too?', 5, QUOTES.answer)] }, 80_000);
  assert.deepEqual(result.accepted.map((accepted) => [accepted.itemId, accepted.reopened]), [['g1', true]]);
  const item = ledger.get('g1');
  assert.equal(item?.status, 'open');
  assert.equal(item?.expiredReason, undefined);
  assert.equal(item?.importance, 5);
  assert.equal(item?.evidence.length, 2);
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.snapshot().unanswered.length, 0);
});

test('snapshot lists stale and displaced items as unanswered, not moot drops', () => {
  const ledger = newLedger({ maxOpen: 1, staleAfterMs: 60_000 });
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 3, QUOTES.archived)] }, 0);
  run(ledger, { raise: [raise('Do duplicate contacts merge, skip, or duplicate?', 4, QUOTES.imports, 'unaddressed')] }, 1000);
  run(ledger, { drop: [{ id: 'g2', reason: 'imports were cut' }] }, 2000);
  assert.deepEqual(
    ledger.snapshot().unanswered.map((item) => [item.id, item.expiredReason]),
    [['g1', 'displaced']],
  );
});

test('resolve is rejected when it quotes the evidence that raised the gap', () => {
  const ledger = newLedger();
  run(ledger, { raise: [raise('Hidden from search only, or the list too?', 4, QUOTES.archived)] }, 1000);
  const result = run(ledger, { resolve: [{ id: 'g1', how: 'They are hidden', evidence: { speaker: 'them', quote: 'archived projects should be hidden' } }] }, 2000);
  assert.equal(result.rejected[0].reason, 'not_an_answer');
  assert.equal(ledger.get('g1')?.status, 'open');
});

test('resolve accepts an answer given later in the segment that raised the gap', () => {
  const long = new TranscriptIndex();
  long.add({ speaker: 'them', text: 'Archived projects should be hidden, but only from search results, the list keeps them.', startMs: 0, endMs: 6000 });
  const ledger = newLedger();
  const apply = (output: Record<string, unknown>, nowMs: number) => ledger.apply(parseModelOutput(output), nowMs, (quote) => long.find(quote));
  apply({ raise: [raise('Hidden from search only, or the list too?', 4, 'Archived projects should be hidden')] }, 1000);
  const result = apply({ resolve: [{ id: 'g1', how: 'Search only', evidence: { speaker: 'them', quote: 'should be hidden but only from search results' } }] }, 2000);
  assert.equal(result.accepted.length, 1);
  assert.equal(ledger.get('g1')?.status, 'resolved');
});
