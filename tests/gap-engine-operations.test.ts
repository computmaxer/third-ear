/**
 * Tests for strict parsing of model output into gap operations.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelOutput } from '../src/core/gap-engine/operations';

const goodRaise = {
  kind: 'ambiguity',
  question: 'Hidden from search only, or the list too?',
  why: 'decides which queries filter archived rows',
  evidence: [{ speaker: 'them', quote: 'archived projects should be hidden' }],
  importance: 4,
};

test('parses a complete, well-formed output', () => {
  const parsed = parseModelOutput({
    raise: [goodRaise],
    resolve: [{ id: 'g1', how: 'Search only', evidence: { speaker: 'them', quote: 'search results only' } }],
    update: [{ id: 'g2', question: null, why: 'new reason', importance: 5 }],
    drop: [{ id: 'g3', reason: 'cut from scope' }],
    bigIdeas: ['  Archive hides projects  ', '', 'Refunds are instant'],
  });
  assert.equal(parsed.rejected.length, 0);
  assert.deepEqual(
    parsed.ops.map((op) => op.op),
    ['raise', 'resolve', 'update', 'drop'],
  );
  assert.deepEqual(parsed.ops[2], { op: 'update', id: 'g2', why: 'new reason', importance: 5 });
  assert.deepEqual(parsed.bigIdeas, ['Archive hides projects', 'Refunds are instant']);
});

test('empty lists are a normal outcome with no rejections', () => {
  const parsed = parseModelOutput({ raise: [], resolve: [], update: [], drop: [], bigIdeas: [] });
  assert.deepEqual(parsed, { ops: [], rejected: [], bigIdeas: [] });
});

test('absent bigIdeas leaves the current list alone', () => {
  assert.equal(parseModelOutput({ raise: [] }).bigIdeas, undefined);
});

test('non-object output is rejected as a whole', () => {
  for (const raw of [null, 'raise everything', 42, [goodRaise]]) {
    const parsed = parseModelOutput(raw);
    assert.equal(parsed.ops.length, 0);
    assert.equal(parsed.rejected[0].reason, 'malformed');
  }
});

test('each malformed op is dropped with a reason while good ops survive', () => {
  const parsed = parseModelOutput({
    raise: [
      goodRaise,
      { ...goodRaise, kind: 'vibe' },
      { ...goodRaise, importance: 4.5 },
      { ...goodRaise, importance: 9 },
      { ...goodRaise, evidence: [] },
      { ...goodRaise, evidence: [{ speaker: 'them' }] },
      { ...goodRaise, question: '   ' },
      { ...goodRaise, why: undefined },
      'raise this',
    ],
    resolve: [{ id: 'g1', how: 'yes', evidence: 'they said so' }],
    update: [{ id: 'g1', importance: 0 }],
    drop: [{ id: 'g1' }],
  });
  assert.equal(parsed.ops.length, 1);
  assert.equal(parsed.rejected.length, 11);
  assert.ok(parsed.rejected.every((r) => r.reason === 'malformed' && r.detail));
});

test('non-array op lists and non-string big ideas are rejected', () => {
  const parsed = parseModelOutput({ raise: goodRaise, bigIdeas: ['ok', 3] });
  assert.equal(parsed.ops.length, 0);
  assert.equal(parsed.bigIdeas, undefined);
  assert.deepEqual(
    parsed.rejected.map((r) => r.detail),
    ['raise must be an array', 'bigIdeas must be an array of strings'],
  );
});

test('big ideas are capped at six', () => {
  const parsed = parseModelOutput({ bigIdeas: ['1', '2', '3', '4', '5', '6', '7', '8'] });
  assert.equal(parsed.bigIdeas?.length, 6);
});
