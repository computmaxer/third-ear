/**
 * Tests for the gap engine's evidence matching and duplicate similarity.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptIndex, lexicalSimilarity, tokenize } from '../src/core/gap-engine/text';

function indexOf(...lines: [string, string, number][]): TranscriptIndex {
  const index = new TranscriptIndex();
  for (const [speaker, text, startMs] of lines) index.add({ speaker, text, startMs, endMs: startMs + 5000 });
  return index;
}

const index = indexOf(
  ['them', 'So the export runs every night at two, and it includes archived projects.', 0],
  ['me', 'Okay. Who gets the email when it fails?', 6000],
  ['them', "We'll refund customers within thirty days, no questions asked.", 12000],
);

test('tokenize lowercases, strips punctuation, diacritics and apostrophes', () => {
  assert.deepEqual(
    tokenize("Café's résumé, DON'T stop!").map((t) => t.norm),
    ['cafes', 'resume', 'dont', 'stop'],
  );
});

test('finds an exact quote regardless of case and punctuation', () => {
  const match = index.find('the EXPORT runs every night at two');
  assert.ok(match);
  assert.equal(match.exact, true);
  assert.equal(match.speaker, 'them');
  assert.equal(match.atMs, 0);
  assert.equal(match.text, 'the export runs every night at two');
});

test('tolerates small speech-recognition differences', () => {
  // "we will" vs "we'll", "refunds" vs "refund", "thirty" kept.
  const match = index.find('we will refunds customers within thirty days no questions');
  assert.ok(match, 'expected a fuzzy match');
  assert.equal(match.exact, false);
  assert.equal(match.speaker, 'them');
  assert.equal(match.atMs, 12000);
  assert.match(match.text, /refund customers within thirty days/);
});

test('reports the transcript speaker, not the speaker the model claimed', () => {
  const match = index.find('who gets the email when it fails');
  assert.equal(match?.speaker, 'me');
});

test('rejects an invented quote that shares a few words', () => {
  assert.equal(index.find('the export must be encrypted with customer keys'), null);
  assert.equal(index.find('refunds require manager approval over five hundred dollars'), null);
});

test('rejects an invented quote made mostly of filler words', () => {
  const filler = indexOf(['them', 'We need to do it at the end of the day for them.', 0]);
  // Over 80% of the words match, but of the meaningful ones only "need" does.
  assert.equal(filler.find('we need to do it at the start of the project'), null);
  assert.ok(filler.find('we need to do it at the end of the day'));
});

test('rejects exact quotes made only of filler words', () => {
  const filler = indexOf(['them', 'so I think that we should probably keep the cutoff at five pm for now and then we can revisit', 0]);
  assert.equal(filler.find('I think that'), null);
  assert.equal(filler.find('and then we'), null);
  assert.equal(filler.find('that we should'), null);
  assert.ok(filler.find('keep the cutoff at five pm'));
});

test('rejects quotes too short to be meaningful evidence', () => {
  assert.equal(index.find('okay'), null);
  assert.equal(index.find('it fails'), null);
});

test('matches a quote that spans two consecutive segments', () => {
  const match = index.find('includes archived projects okay who gets the email');
  assert.ok(match);
  assert.equal(match.speaker, 'them');
  assert.match(match.text, /archived projects\. … Okay\. Who gets the email/);
});

test('returns null on an empty transcript', () => {
  assert.equal(new TranscriptIndex().find('anything at all here'), null);
});

test('lexical similarity treats reworded questions as near-duplicates', () => {
  const a = 'What happens to scheduled payments if the account is closed?';
  const b = 'If the account closes, what happens to a scheduled payment?';
  assert.ok(lexicalSimilarity(a, b) >= 0.8);
});

test('lexical similarity keeps different questions apart', () => {
  const a = 'What happens to scheduled payments if the account is closed?';
  const b = 'Who receives the failure email for the nightly export?';
  assert.ok(lexicalSimilarity(a, b) < 0.2);
});
