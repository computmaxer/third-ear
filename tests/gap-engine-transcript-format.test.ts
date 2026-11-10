/**
 * Tests for reading recorded transcripts (text and JSON) for replay, and for
 * mapping a named speaker to 'me'.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TranscriptFormatError,
  assignMe,
  parseTimestamp,
  parseTranscript,
  speakersOf,
} from '../src/core/gap-engine/transcript-format';

test('parseTimestamp reads mm:ss and hh:mm:ss and rejects malformed values', () => {
  assert.equal(parseTimestamp('03:22'), 202_000);
  assert.equal(parseTimestamp('0:05'), 5000);
  assert.equal(parseTimestamp('75:10'), 4_510_000);
  assert.equal(parseTimestamp('1:02:03'), 3_723_000);
  for (const bad of ['03:60', '1:60:00', '3', 'ab:cd', '1:2:3:4', '', '-1:00', '1.5:00']) {
    assert.equal(parseTimestamp(bad), null, bad);
  }
});

test('text lines become segments with speaker, text and start time', () => {
  const segments = parseTranscript(
    [
      '# a comment line',
      '',
      '[00:03] Dana: Refunds are instant.',
      '[00:10] Dr Okafor : Finance approves big ones.',
      '[1:00:00] Priya: An hour in.',
    ].join('\n'),
  );
  assert.deepEqual(
    segments.map(({ speaker, text, startMs }) => ({ speaker, text, startMs })),
    [
      { speaker: 'Dana', text: 'Refunds are instant.', startMs: 3000 },
      { speaker: 'Dr Okafor', text: 'Finance approves big ones.', startMs: 10_000 },
      { speaker: 'Priya', text: 'An hour in.', startMs: 3_600_000 },
    ],
  );
});

test('a text line ends at the next line or after its estimated speaking time, whichever is sooner', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const segments = parseTranscript(
    [`[00:00] A: ${words(50)}`, `[00:05] B: ${words(10)}`, '[01:00] A: ok', `[02:00] B: ${words(5)}`].join('\n'),
  );
  assert.equal(segments[0].endMs, 5000, 'cut short by the next line');
  assert.equal(segments[1].endMs, 9000, '10 words at 400ms each, then silence until 01:00');
  assert.equal(segments[2].endMs, 61_000, 'at least one second');
  assert.equal(segments[3].endMs, 122_000, 'the last line uses the estimate');
});

test('lines without a timestamp continue the previous line', () => {
  const segments = parseTranscript('[00:01] Dana: The slot goes\n  to whoever answers first.\n[00:09] Priya: Okay.');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, 'The slot goes to whoever answers first.');
});

test('malformed text transcripts fail with the line number', () => {
  const cases: [string, RegExp][] = [
    ['[00:01] A: fine\n[0:5x] B: bad', /line 2: expected/],
    ['[00:01] A: fine\n[00:02] no speaker here', /line 2: expected/],
    ['text before any timestamp', /line 1: expected/],
    ['[00:10] A: later\n[00:05] B: earlier', /line 2: timestamp \[00:05\] is earlier/],
    ['# only a comment\n', /no transcript lines/],
  ];
  for (const [content, message] of cases) {
    assert.throws(() => parseTranscript(content), (error: unknown) => error instanceof TranscriptFormatError && message.test(error.message));
  }
});

test('a JSON array of segments is detected and validated', () => {
  const segments = [
    { speaker: 'me', text: 'Is that per clinic?', startMs: 0, endMs: 2000 },
    { speaker: 'them', text: 'Yes, per clinic.', startMs: 2500, endMs: 4000 },
  ];
  assert.deepEqual(parseTranscript(`\uFEFF  ${JSON.stringify(segments)}`), segments);

  const bad: [unknown, RegExp][] = [
    [[], /no segments/],
    [[{ speaker: '', text: 'x', startMs: 0, endMs: 1 }], /segment 0: speaker/],
    [[{ speaker: 'a', text: 3, startMs: 0, endMs: 1 }], /segment 0: text/],
    [[{ speaker: 'a', text: 'x', startMs: -1, endMs: 1 }], /segment 0: startMs/],
    [[{ speaker: 'a', text: 'x', startMs: 5, endMs: 1 }], /segment 0: endMs/],
    [[{ speaker: 'a', text: 'x', startMs: 0 }], /segment 0: endMs/],
  ];
  for (const [content, message] of bad) {
    assert.throws(() => parseTranscript(JSON.stringify(content)), message);
  }
  assert.throws(() => parseTranscript('[{"speaker": '), /invalid JSON/);
});

test('assignMe relabels one speaker, ignoring case, and names the speakers when it is missing', () => {
  const segments = parseTranscript('[00:01] Max: Hi.\n[00:02] Dana: Hello.\n[00:03] max: Right.');
  assert.deepEqual(
    assignMe(segments, 'MAX').map((segment) => segment.speaker),
    ['me', 'Dana', 'me'],
  );
  assert.throws(() => assignMe(segments, 'Bob'), /no speaker named "Bob" \(speakers: Max, Dana, max\)/);
});

test('the sample meeting fixture parses into a 20+ minute, three-speaker meeting', () => {
  const segments = parseTranscript(readFileSync('fixtures/gap-engine/sample-meeting.txt', 'utf8'));
  assert.deepEqual(speakersOf(segments).sort(), ['Dana', 'Max', 'Priya']);
  assert.ok(segments[segments.length - 1].endMs >= 20 * 60_000);
  for (let i = 1; i < segments.length; i++) assert.ok(segments[i].startMs >= segments[i - 1].startMs);
});
