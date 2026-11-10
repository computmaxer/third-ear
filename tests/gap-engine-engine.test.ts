/**
 * Tests for the gap engine's scheduling, run lifecycle, failure handling and
 * replay. Time is driven by a ManualClock; no network is used.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/core/gap-engine/clock';
import { RealtimeGapDriver, replayTranscript } from '../src/core/gap-engine/drivers';
import { GapEngine, type GapEngineOptions } from '../src/core/gap-engine/engine';
import type { AnalyzeOutput } from '../src/core/gap-engine/model';
import { ScriptedGapModel, scripted } from '../src/core/gap-engine/scripted-model';
import type { GapEvent, TranscriptSegment } from '../src/core/gap-engine/types';

function words(count: number, prefix = 'word'): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
}

function seg(text: string, atMs: number, speaker = 'them'): TranscriptSegment {
  return { speaker, text, startMs: Math.max(0, atMs - 3000), endMs: atMs };
}

function setup(steps: ConstructorParameters<typeof ScriptedGapModel>[0] = [], options: Partial<GapEngineOptions> = {}) {
  const clock = new ManualClock(0);
  const model = new ScriptedGapModel(steps);
  const engine = new GapEngine({ model, clock, ...options });
  return { clock, model, engine };
}

function deferred() {
  let resolve!: (value: AnalyzeOutput) => void;
  const promise = new Promise<AnalyzeOutput>((r) => (resolve = r));
  return { promise, resolve };
}

test('does not run until enough new words arrive', async () => {
  const { clock, engine, model } = setup();
  clock.set(1000);
  engine.addSegment(seg(words(30), 1000));
  assert.equal(engine.isRunning(), false);
  clock.set(2000);
  engine.addSegment(seg(words(29, 'more'), 2000));
  assert.equal(engine.isRunning(), false);
  clock.set(3000);
  engine.addSegment(seg('one more', 3000));
  assert.equal(engine.isRunning(), true);
  await engine.whenIdle();
  assert.equal(model.inputs.length, 1);
  const [run] = engine.runLog();
  assert.equal(run.trigger, 'new_words');
  assert.equal(run.newWordCount, 61);
  assert.equal(run.newSegmentCount, 3);
});

test('enforces minIntervalMs between word-triggered runs', async () => {
  const { clock, engine, model } = setup();
  engine.addSegment(seg(words(60), 0));
  await engine.whenIdle();
  clock.set(10_000);
  engine.addSegment(seg(words(80, 'b'), 10_000));
  assert.equal(engine.isRunning(), false);
  clock.set(24_999);
  assert.equal(engine.tick(), null);
  clock.set(25_000);
  assert.ok(engine.tick());
  await engine.whenIdle();
  assert.equal(model.inputs.length, 2);
});

test('runs on maxWaitMs even with few words', async () => {
  const { clock, engine } = setup();
  clock.set(5000);
  engine.addSegment(seg('we should hide archived ones', 5000));
  clock.set(5000 + 74_999);
  assert.equal(engine.tick(), null);
  clock.set(5000 + 75_000);
  const run = await engine.tick();
  assert.equal(run?.trigger, 'max_wait');
});

test('never runs without unanalysed speech', async () => {
  const { clock, engine, model } = setup();
  clock.set(10 * 60_000);
  assert.equal(engine.tick(), null);
  engine.addSegment(seg('   ', 10 * 60_000));
  assert.equal(engine.tick(), null);
  assert.equal(await engine.flush(), null);
  assert.equal(model.inputs.length, 0);
});

test('never runs concurrently; speech arriving mid-run goes to the next run', async () => {
  const first = deferred();
  const { clock, engine, model } = setup([() => first.promise]);
  engine.addSegment(seg(words(60), 0));
  assert.equal(engine.isRunning(), true);

  clock.set(30_000);
  engine.addSegment(seg(words(70, 'late'), 30_000));
  clock.set(200_000);
  assert.equal(engine.tick(), null, 'a run is already in flight');
  assert.equal(model.inputs.length, 1);

  first.resolve(scripted({ raise: [] }));
  await engine.whenIdle();
  assert.equal(model.inputs.length, 2, 'the follow-up run starts as soon as the first finishes');
  const runs = engine.runLog();
  assert.equal(runs[1].newSegmentCount, 1);
  assert.equal(runs[1].newWordCount, 70);
  const secondTurn = model.inputs[1].turn;
  const newPart = secondTurn.slice(secondTurn.indexOf('--- NEW SINCE LAST ANALYSIS ---'));
  assert.ok(newPart.includes('late0'));
  assert.ok(!newPart.includes('word0'));
});

test('flush forces a final run over leftover speech', async () => {
  const { clock, engine } = setup();
  clock.set(1000);
  engine.addSegment(seg('only a few words', 1000));
  const run = await engine.flush();
  assert.equal(run?.trigger, 'flush');
  assert.equal(await engine.flush(), null, 'nothing left to analyse');
});

test('a failed model call is recorded, never thrown, and its speech is retried later', async () => {
  const failure: AnalyzeOutput = { ok: false, error: { kind: 'rate_limit', message: 'slow down', status: 429 } };
  const { clock, engine, model } = setup([failure], { schedule: { maxWaitMs: 10_000 } });
  engine.addSegment(seg(words(60), 0));
  await engine.whenIdle();
  const [failed] = engine.runLog();
  assert.equal(failed.error?.kind, 'rate_limit');

  // maxWait has passed, but a retry waits minIntervalMs after the failure.
  clock.set(20_000);
  assert.equal(engine.tick(), null);
  clock.set(25_000);
  const retry = await engine.tick();
  assert.equal(retry?.error, undefined);
  assert.equal(retry?.newWordCount, 60, 'the same speech is analysed again');
  assert.ok(model.inputs[1].turn.slice(model.inputs[1].turn.indexOf('NEW SINCE')).includes('word0'));
});

test('a model that throws is treated as a failed run', async () => {
  const { engine } = setup([
    () => {
      throw new Error('socket hang up');
    },
  ]);
  engine.addSegment(seg(words(60), 0));
  await engine.whenIdle();
  assert.deepEqual(engine.runLog()[0].error, { kind: 'unknown', message: 'socket hang up' });
});

test('malformed model output is logged as rejections without crashing', async () => {
  const { engine } = setup([scripted('not json at all'), scripted({ raise: [{ kind: 'nope' }] })]);
  engine.addSegment(seg(words(60), 0));
  await engine.whenIdle();
  assert.equal(engine.runLog()[0].rejected[0].reason, 'malformed');
  assert.deepEqual(engine.snapshot().open, []);
});

test('end to end: raise, events, resolve, run log', async () => {
  const events: GapEvent[] = [];
  const { clock, engine } = setup([
    scripted({
      raise: [
        {
          kind: 'ambiguity',
          question: 'Hidden from search only, or from the project list too?',
          why: 'decides which queries filter archived rows',
          evidence: [{ speaker: 'them', quote: 'archived projects should be hidden' }],
          importance: 4,
        },
      ],
      bigIdeas: ['Archiving hides projects'],
    }),
    scripted({
      resolve: [{ id: 'g1', how: 'Search only', evidence: { speaker: 'them', quote: 'only from search results' } }],
    }),
  ]);
  engine.subscribe((event) => events.push(event));

  engine.addSegment(seg(`Archived projects should be hidden. ${words(60)}`, 10_000));
  await engine.whenIdle();
  assert.deepEqual(
    engine.snapshot().open.map((item) => item.id),
    ['g1'],
  );

  clock.set(40_000);
  engine.addSegment(seg(`They are hidden only from search results. ${words(60, 'x')}`, 40_000));
  await engine.whenIdle();

  assert.deepEqual(
    events.map((e) => e.type),
    ['raised', 'big_ideas', 'resolved'],
  );
  const final = engine.snapshot();
  assert.equal(final.open.length, 0);
  assert.equal(final.resolved[0].resolution?.evidence[0].quote, 'only from search results');
  assert.deepEqual(final.bigIdeas, ['Archiving hides projects']);

  const [first, second] = engine.runLog();
  assert.equal(first.runIndex, 0);
  assert.equal(second.runIndex, 1);
  assert.equal(first.accepted.length, 2);
  assert.ok(first.inputSizes.systemChars > 1000);
  assert.ok(first.rawOutput);
  assert.equal(second.atMs, 40_000);
  assert.equal(second.accepted[0].itemId, 'g1');
});

test('the second run sees the ledger and big ideas from the first', async () => {
  const { clock, engine, model } = setup([
    scripted({
      raise: [
        {
          kind: 'unaddressed',
          question: 'What happens to duplicate contacts on import?',
          why: 'decides the merge logic',
          evidence: [{ speaker: 'them', quote: 'imports dedupe contacts' }],
          importance: 4,
        },
      ],
      bigIdeas: ['Bulk import with dedupe'],
    }),
  ]);
  engine.addSegment(seg(`Imports dedupe contacts. ${words(60)}`, 0));
  await engine.whenIdle();
  clock.set(30_000);
  engine.addSegment(seg(words(60, 'y'), 30_000));
  await engine.whenIdle();
  const turn = model.inputs[1].turn;
  assert.match(turn, /\[g1\] unaddressed, importance 4/);
  assert.match(turn, /- Bulk import with dedupe/);
  assert.equal(model.inputs[1].system, model.inputs[0].system);
  assert.equal(model.inputs[1].stableContext, model.inputs[0].stableContext);
});

test('tick expires stale items even when nobody is talking', async () => {
  const { clock, engine } = setup(
    [
      scripted({
        raise: [
          {
            kind: 'ambiguity',
            question: 'Hidden from search only?',
            why: 'query filters',
            evidence: [{ speaker: 'them', quote: 'archived projects should be hidden' }],
            importance: 4,
          },
        ],
      }),
    ],
    { ledger: { staleAfterMs: 60_000 } },
  );
  engine.addSegment(seg(`Archived projects should be hidden. ${words(60)}`, 0));
  await engine.whenIdle();
  clock.set(59_999);
  engine.tick();
  assert.equal(engine.snapshot().open.length, 1);
  clock.set(60_000);
  engine.tick();
  assert.equal(engine.snapshot().open.length, 0);
  assert.equal(engine.items()[0].expiredReason, 'stale');
});

test('user actions go through the engine', async () => {
  const { engine } = setup([
    scripted({
      raise: [
        {
          kind: 'ambiguity',
          question: 'Hidden from search only?',
          why: 'query filters',
          evidence: [{ speaker: 'them', quote: 'archived projects should be hidden' }],
          importance: 4,
        },
      ],
    }),
  ]);
  engine.addSegment(seg(`Archived projects should be hidden. ${words(60)}`, 0));
  await engine.whenIdle();
  assert.equal(engine.dismiss('g1'), true);
  assert.equal(engine.snapshot().open.length, 0);
  assert.equal(engine.restore('g1'), true);
  assert.equal(engine.markResolved('g1'), true);
  assert.equal(engine.snapshot().resolved.length, 1);
});

test('replayTranscript drives a recorded meeting deterministically and instantly', async () => {
  const segments: TranscriptSegment[] = [
    seg(`Refunds are instant for every customer. ${words(20)}`, 10_000),
    seg(words(45, 'a'), 20_000, 'me'),
    seg(`Finance approves any refund over five hundred dollars. ${words(10, 'b')}`, 200_000),
    seg('Got it, thanks everyone.', 300_000, 'me'),
  ];
  const model = new ScriptedGapModel([
    scripted({ raise: [] }),
    scripted({
      raise: [
        {
          kind: 'contradiction',
          question: 'Are refunds over $500 instant, or held for finance approval?',
          why: 'decides whether refunds need an approval state',
          evidence: [
            { speaker: 'them', quote: 'refunds are instant for every customer' },
            { speaker: 'them', quote: 'finance approves any refund over five hundred dollars' },
          ],
          importance: 5,
        },
      ],
    }),
  ]);

  const started = Date.now();
  const result = await replayTranscript(segments, { model });
  assert.ok(Date.now() - started < 2000, 'replay does not wait in real time');
  assert.deepEqual(
    result.runs.map((run) => run.trigger),
    ['new_words', 'max_wait', 'flush'],
  );
  assert.equal(result.runs[1].atMs, 275_000, 'max wait fires 75s after the segment arrived, during the silence');
  assert.equal(result.snapshot.open[0].kind, 'contradiction');
  assert.deepEqual(
    result.snapshot.open[0].evidence.map((e) => e.atMs),
    [7000, 197_000],
  );
});

test('realtime driver flushes on stop', async () => {
  const { engine } = setup();
  const driver = new RealtimeGapDriver(engine, 10);
  driver.start();
  engine.addSegment(seg('just a few words', 0));
  const run = await driver.stop();
  assert.equal(run?.trigger, 'flush');
});

function slowCountingModel() {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const model = {
    async analyze(): Promise<AnalyzeOutput> {
      stats.calls++;
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      stats.inFlight--;
      return scripted({ raise: [] });
    },
  };
  return { model, stats };
}

test('two flushes in the same turn start one run', async () => {
  const { model, stats } = slowCountingModel();
  const engine = new GapEngine({ model, clock: new ManualClock(0) });
  engine.addSegment(seg('only a few words', 0));
  const [first, second] = await Promise.all([engine.flush(), engine.flush()]);
  await engine.whenIdle();
  assert.equal(first?.trigger, 'flush');
  assert.equal(second, null);
  assert.deepEqual(stats, { calls: 1, inFlight: 0, maxInFlight: 1 });
});

test('speech arriving in the same turn as flush goes to a later run, never a concurrent one', async () => {
  const { model, stats } = slowCountingModel();
  const engine = new GapEngine({ model, clock: new ManualClock(0) });
  engine.addSegment(seg('only a few words', 0));
  const flushed = engine.flush();
  engine.addSegment(seg(words(80), 0));
  await flushed;
  await engine.whenIdle();
  assert.equal(stats.maxInFlight, 1);
  assert.equal(engine.runLog()[0].newSegmentCount, 1);
});

test('a model that always fails is retried with a growing delay, even with minIntervalMs 0', async () => {
  const failure: AnalyzeOutput = { ok: false, error: { kind: 'auth', message: 'invalid x-api-key', status: 401 } };
  const model = new ScriptedGapModel([], failure);
  const segments = Array.from({ length: 20 }, (_, i) => seg(words(70, `s${i}`), (i + 1) * 60_000));
  const result = await replayTranscript(segments, { model, schedule: { minIntervalMs: 0 } });
  assert.ok(result.runs.length > 1 && result.runs.length <= 12, `bounded retries, got ${result.runs.length}`);
  const gaps = result.runs.slice(1).map((run, i) => run.atMs - result.runs[i].atMs);
  assert.ok(gaps[0] >= 10_000, 'the first retry waits retryDelayMs');
  assert.ok(gaps[1] >= 2 * gaps[0] - 1000, 'the wait doubles');
});

test('a success resets the retry delay', async () => {
  const failure: AnalyzeOutput = { ok: false, error: { kind: 'network', message: 'offline' } };
  const { clock, engine } = setup([failure, scripted({ raise: [] }), failure], { schedule: { maxWaitMs: 1000 } });
  engine.addSegment(seg(words(60), 0));
  await engine.whenIdle();
  clock.set(25_000);
  await engine.tick();
  assert.equal(engine.runLog()[1].error, undefined);
  clock.set(60_000);
  engine.addSegment(seg(words(60, 'b'), 60_000));
  await engine.whenIdle();
  clock.set(84_999);
  assert.equal(engine.tick(), null);
  clock.set(85_000);
  assert.ok(engine.tick(), 'back to the base delay after a success');
});

test('raises held back for pacing are shown in the next turn; invented ones are not', async () => {
  const late = {
    kind: 'unaddressed',
    question: 'What happens to a late YES?',
    why: 'needs a defined outcome',
    evidence: [{ speaker: 'them', quote: 'it moves on to the next person' }],
    importance: 4,
  };
  const invented = { ...late, question: 'Is there an invented thing?', evidence: [{ speaker: 'them', quote: 'nobody ever said these words' }] };
  const { clock, engine, model } = setup([
    scripted({
      raise: [{ ...late, question: 'When do unanswered offers expire?', evidence: [{ speaker: 'them', quote: 'offers expire overnight' }] }],
    }),
    scripted({ raise: [late, invented] }),
  ]);
  engine.addSegment(seg(`If nobody answers it moves on to the next person. Offers expire overnight. ${words(60)}`, 0));
  await engine.whenIdle();
  clock.set(30_000);
  engine.addSegment(seg(words(60, 'b'), 30_000));
  await engine.whenIdle();
  assert.deepEqual(
    engine.runLog()[1].rejected.map((rejection) => rejection.reason),
    ['cooldown', 'evidence_not_found'],
  );
  clock.set(60_000);
  engine.addSegment(seg(words(60, 'c'), 60_000));
  await engine.whenIdle();
  const turn = model.inputs[2].turn;
  assert.match(turn, /Held back last run \(not shown to the engineer\):\n- What happens to a late YES\? \(another gap had just been raised\)/);
  assert.ok(!turn.includes('invented thing'));
});

test('each run sends the previous history plus its own speech as one new block', async () => {
  const { clock, engine, model } = setup();
  engine.addSegment(seg(`We send it to everybody at once. ${words(60)}`, 0));
  await engine.whenIdle();
  clock.set(10 * 60_000);
  engine.addSegment(seg(words(60, 'b'), 10 * 60_000));
  await engine.whenIdle();
  clock.set(20 * 60_000);
  engine.addSegment(seg(words(60, 'c'), 20 * 60_000));
  await engine.whenIdle();
  const [first, second, third] = model.inputs.map((input) => input.history);
  assert.equal(first.length, 1);
  assert.deepEqual(third.slice(0, second.length), second);
  assert.equal(third.length, second.length + 1);
  assert.ok(third.join('').includes('everybody at once'), 'speech from twenty minutes ago is still shown');
  assert.equal(engine.runLog()[2].inputSizes.historyChars, third.join('').length);
});
