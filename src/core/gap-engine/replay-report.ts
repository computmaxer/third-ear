/**
 * Renders a replay as a readable timeline and summary, for the terminal and
 * for a markdown report. The same lines feed both, so the two never drift.
 * Nothing here depends on wall-clock time unless it is passed in, so the
 * output of an offline replay is deterministic.
 */

import type { RunRecord } from './engine';
import type { AcceptedOp } from './ledger';
import type { RejectedOp } from './operations';
import { formatTime } from './prompt';
import type { ReplayReport, ReplaySettings, TimelineEntry } from './replay';
import type { Evidence, GapItem } from './types';

export interface ReportLine {
  /** 0 = timeline entry, 1 = what happened, 2 = detail. */
  depth: 0 | 1 | 2;
  text: string;
}

export interface DescribeOptions {
  /** Include transcript lines and per-run input sizes, tokens and latency. */
  verbose?: boolean;
}

export function describeSettings(settings: ReplaySettings): string {
  const { schedule, ledger, transcript } = settings;
  return [
    `max open ${ledger.maxOpen}`,
    `min new words ${schedule.minNewWords}`,
    `min interval ${schedule.minIntervalMs / 1000}s`,
    `max wait ${schedule.maxWaitMs / 1000}s`,
    `retry delay ${schedule.retryDelayMs / 1000}s`,
    `transcript cap ${transcript.maxHistoryChars} chars`,
    `importance floor ${ledger.importanceFloor}`,
    `raise cooldown ${ledger.raiseCooldownMs / 1000}s`,
    `stale after ${ledger.staleAfterMs / 60_000} min`,
  ].join(', ');
}

export function describeEntry(entry: TimelineEntry, options: DescribeOptions = {}): ReportLine[] {
  switch (entry.type) {
    case 'speech':
      if (!options.verbose) return [];
      return [{ depth: 0, text: `[${formatTime(entry.segment.startMs)}]   ${entry.segment.speaker}: ${entry.segment.text}` }];
    case 'stale':
      return [
        {
          depth: 0,
          text: `[${formatTime(entry.atMs)}] EXPIRED ${entry.item.id} (untouched too long): ${entry.item.question}`,
        },
      ];
    case 'run':
      return describeRun(entry, options);
  }
}

function describeRun(entry: Extract<TimelineEntry, { type: 'run' }>, options: DescribeOptions): ReportLine[] {
  const { run } = entry;
  const items = new Map(entry.items.map((item) => [item.id, item]));
  const raised = run.accepted.some((accepted) => accepted.op.op === 'raise');
  const outcome = run.error ? `FAILED (${run.error.kind}) ${run.error.message}` : raised ? '' : 'nothing raised';
  const header = `[${formatTime(run.atMs)}] run ${run.runIndex + 1} (${run.trigger}, ${run.newWordCount} new words)`;
  const lines: ReportLine[] = [{ depth: 0, text: outcome ? `${header}: ${outcome}` : header }];

  if (options.verbose) lines.push({ depth: 2, text: runStats(run) });
  for (const accepted of run.accepted) lines.push(...describeAccepted(accepted, items, entry.bigIdeasBefore));
  for (const rejected of run.rejected) lines.push(...describeRejected(rejected));
  return lines;
}

function runStats(run: RunRecord): string {
  const parts = [
    `transcript ${formatTime(run.transcriptRange.fromMs)}-${formatTime(run.transcriptRange.toMs)}`,
    `history ${run.inputSizes.historyChars} chars`,
    `turn ${run.inputSizes.turnChars} chars`,
  ];
  if (run.usage) {
    const { inputTokens, outputTokens, cacheReadInputTokens = 0, cacheCreationInputTokens = 0 } = run.usage;
    const total = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
    const cached = cacheReadInputTokens > 0 ? ` (${cacheReadInputTokens} cached)` : '';
    parts.push(`tokens ${total} in${cached} / ${outputTokens} out`);
  }
  parts.push(`latency ${(run.latencyMs / 1000).toFixed(1)}s`);
  return parts.join(', ');
}

function quoteLine(evidence: Evidence): ReportLine {
  return { depth: 2, text: `evidence [${formatTime(evidence.atMs)}] ${evidence.speaker}: "${evidence.quote}"` };
}

function describeAccepted(accepted: AcceptedOp, items: Map<string, GapItem>, bigIdeasBefore: string[]): ReportLine[] {
  const { op } = accepted;
  const item = accepted.itemId ? items.get(accepted.itemId) : undefined;
  switch (op.op) {
    case 'raise': {
      const verb = accepted.reopened ? 'REOPENED' : 'RAISED';
      const lines: ReportLine[] = [
        { depth: 1, text: `${verb} ${accepted.itemId} ${op.kind} (importance ${op.importance}): ${op.question}` },
        { depth: 2, text: `why: ${op.why}` },
        ...(item?.evidence ?? []).map(quoteLine),
      ];
      if (accepted.displacedId) {
        const displaced = items.get(accepted.displacedId);
        lines.push({ depth: 2, text: `pushed out ${accepted.displacedId} to stay within budget: ${displaced?.question ?? ''}` });
      }
      return lines;
    }
    case 'resolve':
      return [
        { depth: 1, text: `RESOLVED ${op.id}: ${item?.question ?? ''}` },
        { depth: 2, text: `how: ${op.how}` },
        ...(item?.resolution?.evidence ?? []).map(quoteLine),
      ];
    case 'update': {
      const changes = [
        op.question !== undefined ? `question: ${op.question}` : null,
        op.why !== undefined ? `why: ${op.why}` : null,
        op.importance !== undefined ? `importance: ${op.importance}` : null,
      ].filter((change): change is string => change !== null);
      return [
        { depth: 1, text: `UPDATED ${op.id}` },
        ...changes.map((change) => ({ depth: 2 as const, text: change })),
      ];
    }
    case 'drop':
      return [
        { depth: 1, text: `DROPPED ${op.id}: ${item?.question ?? ''}` },
        { depth: 2, text: `reason: ${op.reason}` },
      ];
    case 'big_ideas': {
      const added = op.bigIdeas.filter((idea) => !bigIdeasBefore.includes(idea));
      const removed = bigIdeasBefore.filter((idea) => !op.bigIdeas.includes(idea));
      return [
        { depth: 1, text: 'BIG IDEAS changed' },
        ...added.map((idea) => ({ depth: 2 as const, text: `+ ${idea}` })),
        ...removed.map((idea) => ({ depth: 2 as const, text: `- ${idea}` })),
      ];
    }
  }
}

function describeRejected(rejected: RejectedOp): ReportLine[] {
  const op = rejected.op as Record<string, unknown> | null;
  let subject = '';
  if (op && typeof op === 'object' && typeof op.op === 'string') {
    subject = op.op === 'raise' ? `raise: ${String(op.question)}` : `${op.op} ${String(op.id)}`;
  }
  const lines: ReportLine[] = [{ depth: 1, text: `REJECTED [${rejected.reason}]${subject ? ` ${subject}` : ''}` }];
  if (rejected.detail) lines.push({ depth: 2, text: rejected.detail });
  return lines;
}

export interface SummaryOptions {
  /** Wall-clock duration of the replay; omitted from the summary when not given. */
  wallMs?: number;
  /** Offline script responses that no run reached. */
  unusedResponses?: number;
}

export function describeSummary(report: ReplayReport, options: SummaryOptions = {}): ReportLine[] {
  const { runs, snapshot } = report;
  const failed = runs.filter((run) => run.error).length;
  const accepted = runs.flatMap((run) => run.accepted);
  const rejected = runs.flatMap((run) => run.rejected);
  const isRaise = (rejection: RejectedOp) => (rejection.op as { op?: unknown } | null)?.op === 'raise';
  const raisesAccepted = accepted.filter((entry) => entry.op.op === 'raise').length;
  const raiseRejections = rejected.filter(isRaise);
  const otherRejections = rejected.filter((rejection) => !isRaise(rejection));

  const lines: ReportLine[] = [
    { depth: 0, text: `runs: ${runs.length}${failed > 0 ? ` (${failed} failed)` : ''}` },
    {
      depth: 0,
      text: `raises: ${raisesAccepted} accepted, ${raiseRejections.length} rejected${countByReason(raiseRejections)}`,
    },
  ];
  if (otherRejections.length > 0) {
    lines.push({ depth: 0, text: `other rejected operations: ${otherRejections.length}${countByReason(otherRejections)}` });
  }
  lines.push({ depth: 0, text: `items resolved: ${snapshot.resolved.length}` });

  lines.push({ depth: 0, text: `open at the end: ${snapshot.open.length}` });
  for (const item of snapshot.open) {
    lines.push({ depth: 1, text: `${item.id} ${item.kind} (importance ${item.importance}): ${item.question}` });
  }
  lines.push({ depth: 0, text: `retired unanswered: ${snapshot.unanswered.length}` });
  for (const item of snapshot.unanswered) {
    lines.push({ depth: 1, text: `${item.id} ${item.kind} (${item.expiredReason}): ${item.question}` });
  }
  lines.push({ depth: 0, text: `big ideas at the end: ${snapshot.bigIdeas.length}` });
  for (const idea of snapshot.bigIdeas) lines.push({ depth: 1, text: idea });

  const usage = runs.reduce(
    (total, run) => ({
      input: total.input + (run.usage?.inputTokens ?? 0),
      output: total.output + (run.usage?.outputTokens ?? 0),
      cacheRead: total.cacheRead + (run.usage?.cacheReadInputTokens ?? 0),
      cacheWrite: total.cacheWrite + (run.usage?.cacheCreationInputTokens ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  lines.push({
    depth: 0,
    text: `tokens: ${usage.input + usage.cacheRead + usage.cacheWrite} input (${usage.input} uncached, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write), ${usage.output} output`,
  });
  if (options.wallMs !== undefined) {
    const modelMs = runs.reduce((total, run) => total + run.latencyMs, 0);
    lines.push({ depth: 0, text: `wall time: ${seconds(options.wallMs)} (waiting on the model ${seconds(modelMs)})` });
  }
  if (options.unusedResponses) {
    lines.push({ depth: 0, text: `offline script responses never used: ${options.unusedResponses}` });
  }
  return lines;
}

function countByReason(rejections: RejectedOp[]): string {
  if (rejections.length === 0) return '';
  const counts = new Map<string, number>();
  for (const rejection of rejections) counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
  return ` (${[...counts].map(([reason, count]) => `${reason} ${count}`).join(', ')})`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const TEXT_INDENT = ['', '    ', '        '];
const MARKDOWN_INDENT = ['- ', '  - ', '    - '];

export function formatText(lines: ReportLine[]): string {
  return lines.map((line) => TEXT_INDENT[line.depth] + line.text).join('\n');
}

export function formatMarkdown(lines: ReportLine[]): string {
  return lines.map((line) => MARKDOWN_INDENT[line.depth] + line.text).join('\n');
}

export interface ReportHeader {
  transcript: string;
  model: string;
}

export function renderMarkdownReport(
  report: ReplayReport,
  header: ReportHeader,
  options: DescribeOptions & SummaryOptions = {},
): string {
  const lastSegment = report.segments[report.segments.length - 1];
  const timeline = report.entries.flatMap((entry) => describeEntry(entry, options));
  return [
    '# Gap engine replay',
    '',
    formatMarkdown([
      { depth: 0, text: `transcript: ${header.transcript} (${report.segments.length} segments, ${formatTime(lastSegment?.endMs ?? 0)})` },
      { depth: 0, text: `model: ${header.model}` },
      { depth: 0, text: `settings: ${describeSettings(report.settings)}` },
    ]),
    '',
    '## Timeline',
    '',
    formatMarkdown(timeline),
    '',
    '## Summary',
    '',
    formatMarkdown(describeSummary(report, options)),
    '',
  ].join('\n');
}

/**
 * The full run log, with each run's prompt and raw output, for diffing
 * between replays. Until the history cap trims the transcript, each run's
 * history is the first `historyBlocks` blocks of the top-level `history`,
 * which is the last run's.
 */
export function buildRunLog(report: ReplayReport, header: ReportHeader) {
  return {
    transcript: header.transcript,
    model: header.model,
    settings: report.settings,
    system: report.inputs[0]?.system ?? null,
    stableContext: report.inputs[0]?.stableContext ?? null,
    history: report.inputs[report.inputs.length - 1]?.history ?? [],
    runs: report.runs.map((run, index) => ({
      ...run,
      historyBlocks: report.inputs[index]?.history.length ?? 0,
      turn: report.inputs[index]?.turn ?? null,
    })),
    final: { snapshot: report.snapshot, items: report.items },
  };
}
