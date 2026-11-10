/**
 * Tests for offline replay: the timed script model, an end-to-end replay of
 * the sample meeting (which must be deterministic), the report renderers and
 * the replay command line. No network is used.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../src/core/gap-engine/clock';
import { OfflineScriptError, TimedScriptModel, parseOfflineScript, runReplay } from '../src/core/gap-engine/replay';
import {
  buildRunLog,
  describeEntry,
  describeSummary,
  formatText,
  renderMarkdownReport,
} from '../src/core/gap-engine/replay-report';
import { assignMe, parseTranscript } from '../src/core/gap-engine/transcript-format';

const TRANSCRIPT = 'fixtures/gap-engine/sample-meeting.txt';
const SCRIPT = 'fixtures/gap-engine/sample-offline-script.json';

test('parseOfflineScript reads timed responses and rejects malformed scripts', () => {
  assert.deepEqual(
    parseOfflineScript('{"responses": [{"at": "00:30", "note": "x", "output": {"raise": []}}, {"at": "1:00:00", "output": {}}]}'),
    [
      { atMs: 30_000, output: { raise: [] } },
      { atMs: 3_600_000, output: {} },
    ],
  );
  const bad: [string, RegExp][] = [
    ['not json', /invalid JSON/],
    ['[]', /"responses" array/],
    ['{"responses": [3]}', /responses\[0\]: not an object/],
    ['{"responses": [{"at": 30, "output": {}}]}', /responses\[0\]: "at"/],
    ['{"responses": [{"at": "00:30"}]}', /responses\[0\]: "output" is missing/],
    ['{"responses": [{"at": "01:00", "output": {}}, {"at": "00:30", "output": {}}]}', /responses\[1\]: .*time order/],
  ];
  for (const [content, message] of bad) {
    assert.throws(() => parseOfflineScript(content), (error: unknown) => error instanceof OfflineScriptError && message.test(error.message));
  }
});

test('TimedScriptModel answers each response once, from its time onward, and leaves big ideas alone otherwise', async () => {
  const clock = new ManualClock(0);
  const model = new TimedScriptModel(
    [
      { atMs: 10_000, output: { bigIdeas: ['first'] } },
      { atMs: 10_000, output: { bigIdeas: ['second'] } },
      { atMs: 60_000, output: { bigIdeas: ['third'] } },
    ],
    clock,
  );
  const outputs = async () => {
    const result = await model.analyze();
    return result.ok ? result.output : null;
  };

  clock.set(5000);
  assert.deepEqual(await outputs(), { raise: [], resolve: [], update: [], drop: [] });
  clock.set(20_000);
  assert.deepEqual(await outputs(), { bigIdeas: ['first'] });
  assert.deepEqual(await outputs(), { bigIdeas: ['second'] }, 'a second due response waits for the next run');
  assert.equal(((await outputs()) as { bigIdeas?: unknown }).bigIdeas, undefined);
  assert.deepEqual(
    model.unused().map((response) => response.atMs),
    [60_000],
  );
});

async function replaySample() {
  const segments = assignMe(parseTranscript(readFileSync(TRANSCRIPT, 'utf8')), 'Max');
  const clock = new ManualClock(0);
  const model = new TimedScriptModel(parseOfflineScript(readFileSync(SCRIPT, 'utf8')), clock);
  const report = await runReplay({ segments, model, clock, brief: { brief: 'Waitlist auto-fill' } });
  const timeline = formatText(report.entries.flatMap((entry) => describeEntry(entry)));
  const summary = formatText(describeSummary(report, { unusedResponses: model.unused().length }));
  return { report, timeline, summary, model };
}

test('offline replay of the sample meeting is deterministic and applies every ledger rule', async () => {
  const first = await replaySample();
  const second = await replaySample();
  assert.equal(first.timeline, second.timeline);
  assert.equal(first.summary, second.summary);
  assert.equal(first.model.unused().length, 0, 'every scripted response is reached');

  const { report } = first;
  const byId = new Map(report.items.map((item) => [item.id, item]));
  assert.deepEqual(
    report.items.map((item) => [item.id, item.kind, item.status, item.expiredReason ?? null]),
    [
      ['g1', 'ambiguity', 'resolved', null],
      ['g2', 'unaddressed', 'expired', 'stale'],
      ['g3', 'ambiguity', 'expired', 'displaced'],
      ['g4', 'contradiction', 'resolved', null],
      ['g5', 'unaddressed', 'resolved', null],
      ['g6', 'implicit_decision', 'open', null],
    ],
  );
  assert.deepEqual(byId.get('g1')?.resolution?.evidence, [
    { speaker: 'Dana', quote: "I just mean they're on the waitlist for that clinic", atMs: 760_000 },
  ]);
  assert.deepEqual(
    report.runs.flatMap((run) => run.rejected.map((rejection) => rejection.reason)),
    ['below_importance_floor', 'evidence_not_found', 'cooldown', 'over_budget', 'duplicate'],
  );
  assert.equal(report.snapshot.bigIdeas.length, 5);
  assert.ok(report.runs.every((run) => run.atMs === run.completedAtMs), 'the virtual clock does not move during a run');

  assert.match(first.timeline, /^\[04:18\] run 6 \(new_words, 64 new words\)$/m);
  assert.match(first.timeline, /^ {4}RAISED g1 ambiguity \(importance 4\): Does 'close by' mean/m);
  assert.match(first.timeline, /^ {8}evidence \[03:22\] Dana: "we'd only offer it to people who are close by"$/m);
  assert.match(first.timeline, /^ {4}REJECTED \[evidence_not_found\] raise: Do all clinics share one waitlist/m);
  assert.match(first.timeline, /^ {8}pushed out g3 to stay within budget/m);
  assert.match(first.timeline, /^\[19:36\] EXPIRED g2 \(untouched too long\)/m);
  assert.match(first.timeline, /^\[00:36\] run 1 \(new_words, 65 new words\): nothing raised$/m);
  assert.doesNotMatch(first.timeline, /Dana: Sure\./, 'transcript lines appear only in verbose mode');

  assert.match(first.summary, /^runs: 29$/m);
  assert.match(
    first.summary,
    /^raises: 6 accepted, 5 rejected \(below_importance_floor 1, evidence_not_found 1, cooldown 1, over_budget 1, duplicate 1\)$/m,
  );
  assert.match(first.summary, /^items resolved: 3$/m);
  assert.match(first.summary, /^open at the end: 1\n {4}g6 implicit_decision/m);
  assert.match(first.summary, /^retired unanswered: 2\n {4}g2 unaddressed \(stale\): .*\n {4}g3 ambiguity \(displaced\): /m);
  assert.match(first.summary, /^tokens: 0 input \(0 uncached, 0 cache read, 0 cache write\), 0 output$/m);
  assert.doesNotMatch(first.summary, /wall time/);
});

test('the markdown report and run log carry the timeline, prompts and raw outputs', async () => {
  const { report } = await replaySample();
  const header = { transcript: TRANSCRIPT, model: 'offline script' };
  const markdown = renderMarkdownReport(report, header, { wallMs: 1500 });
  assert.match(markdown, /^# Gap engine replay$/m);
  assert.match(markdown, /^## Timeline$/m);
  assert.match(markdown, /^- \[04:18\] run 6 /m);
  assert.match(markdown, /^ {2}- RAISED g1 /m);
  assert.match(markdown, /^## Summary$/m);
  assert.match(markdown, /^- wall time: 1\.5s/m);

  const log = buildRunLog(report, header);
  assert.equal(log.runs.length, report.runs.length);
  assert.ok(log.system && log.system.includes('# The four kinds of gap'));
  assert.match(log.stableContext ?? '', /Waitlist auto-fill/);
  assert.ok(log.runs.every((run) => typeof run.turn === 'string' && run.turn.includes('--- NEW SINCE LAST ANALYSIS ---')));
  assert.ok(log.history[0].startsWith('<transcript>'));
  assert.equal(log.runs[log.runs.length - 1].historyBlocks, log.history.length);
  assert.ok(log.runs[5].rawOutput, 'raw model output is kept');
  assert.equal(log.final.snapshot.open[0].id, 'g6');
});

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/replay.ts', ...args], { env, encoding: 'utf8' });
}

test('the replay command writes report.md and runs.json for an offline replay', () => {
  const out = mkdtempSync(join(tmpdir(), 'gap-replay-'));
  try {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const result = runCli([TRANSCRIPT, '--me', 'Max', '--offline', SCRIPT, '--out', out], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RAISED g1 ambiguity/);
    assert.match(result.stdout, /^Summary$/m);
    assert.ok(existsSync(join(out, 'report.md')));
    const log = JSON.parse(readFileSync(join(out, 'runs.json'), 'utf8'));
    assert.equal(log.runs.length, 29);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('token totals count cached input as input', async () => {
  const { report } = await replaySample();
  report.runs[0].usage = { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 4000, cacheCreationInputTokens: 500 };
  const summary = formatText(describeSummary(report));
  assert.match(summary, /^tokens: 5500 input \(1000 uncached, 4000 cache read, 500 cache write\), 50 output$/m);
  const verbose = formatText(describeEntry(report.entries.find((entry) => entry.type === 'run')!, { verbose: true }));
  assert.match(verbose, /tokens 5500 in \(4000 cached\) \/ 50 out/);
});

test('the replay command fails fast on an output path it cannot create', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gap-replay-'));
  try {
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, '');
    const result = runCli([TRANSCRIPT, '--offline', SCRIPT, '--out', blocker], process.env);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '', 'nothing is replayed');
    assert.match(result.stderr, /^replay: cannot write to .*not-a-dir: EEXIST$/m);
    assert.doesNotMatch(result.stderr, /\n\s+at /, 'no stack trace');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the replay command exits non-zero when every model call failed', () => {
  const out = mkdtempSync(join(tmpdir(), 'gap-replay-'));
  try {
    // Nothing listens on the discard port, so every call fails at once with a connection error.
    const env = { ...process.env, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
    const result = runCli([TRANSCRIPT, '--out', out], env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /FAILED \(network\)/);
    assert.match(result.stderr, /^replay: every model call failed/m);
    assert.ok(existsSync(join(out, 'runs.json')), 'the report is still written for diagnosis');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the replay command explains how to proceed without an API key', () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const result = runCli([TRANSCRIPT], env);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const message = result.stderr.trim();
  assert.equal(message.split('\n').length, 1);
  assert.match(message, /ANTHROPIC_API_KEY/);
  assert.match(message, /--offline/);
});
