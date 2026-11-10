/**
 * The gap engine: buffers transcript segments, decides when an analysis run
 * is worth making, asks the model for ledger operations, and applies them
 * through the ledger's precision rules.
 *
 * Scheduling is event-driven: addSegment() and tick() check whether a run is
 * due; nothing runs on a blind timer. Time comes from an injected Clock so a
 * whole meeting can be replayed instantly.
 */

import { meetingClock, type Clock } from './clock';
import { notifySafely } from './notify';
import { GapLedger, type AcceptedOp, type LedgerOptions } from './ledger';
import type { AnalyzeInput, GapModel, GapModelError, TokenUsage } from './model';
import { parseModelOutput, type RejectedOp } from './operations';
import {
  buildStableContext,
  buildTurn,
  DEFAULT_TRANSCRIPT_OPTIONS,
  GAP_SYSTEM_PROMPT,
  type HeldBackRaise,
  type TranscriptOptions,
} from './prompt';
import { DEFAULT_EVIDENCE_MATCH, TranscriptIndex, wordCount, type EvidenceMatchOptions } from './text';
import type { GapEventListener, GapItem, GapSnapshot, MeetingBrief, TranscriptSegment } from './types';

export interface ScheduleOptions {
  /** New words needed (together with minIntervalMs) before a run. */
  minNewWords: number;
  /** Minimum time between run starts on the word-count path. */
  minIntervalMs: number;
  /** Run regardless of word count once the oldest unanalysed speech is this old. */
  maxWaitMs: number;
  /**
   * Wait after a failed run before retrying (at least minIntervalMs). It
   * doubles with each further consecutive failure, up to MAX_RETRY_DELAY_MS.
   */
  retryDelayMs: number;
}

export const DEFAULT_SCHEDULE: ScheduleOptions = {
  minNewWords: 60,
  minIntervalMs: 25_000,
  maxWaitMs: 75_000,
  retryDelayMs: 10_000,
};

export const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** Floor on the retry wait, so a zero setting cannot become a tight retry loop. */
const MIN_RETRY_DELAY_MS = 1000;

/** Raises the ledger held back for these reasons are shown to the model on the next run. */
const HELD_BACK_REASONS = new Set(['cooldown', 'over_budget', 'max_raises_per_run']);

export type RunTrigger = 'new_words' | 'max_wait' | 'flush';

export interface RunRecord {
  runIndex: number;
  trigger: RunTrigger;
  atMs: number;
  completedAtMs: number;
  newWordCount: number;
  newSegmentCount: number;
  /** Meeting time covered by the transcript lines the model was shown. */
  transcriptRange: { fromMs: number; toMs: number };
  inputSizes: { systemChars: number; stableContextChars: number; historyChars: number; turnChars: number };
  rawOutput?: unknown;
  model?: string;
  accepted: AcceptedOp[];
  rejected: RejectedOp[];
  latencyMs: number;
  usage?: TokenUsage;
  error?: GapModelError;
}

export type RunListener = (record: RunRecord) => void;

export interface GapEngineOptions {
  model: GapModel;
  brief?: MeetingBrief;
  clock?: Clock;
  schedule?: Partial<ScheduleOptions>;
  ledger?: Partial<LedgerOptions>;
  transcript?: Partial<TranscriptOptions>;
  evidence?: Partial<EvidenceMatchOptions>;
  /** Wall-clock source for measuring model latency (independent of the meeting clock). */
  latencyNow?: () => number;
}

export class GapEngine {
  private readonly model: GapModel;
  private readonly clock: Clock;
  private readonly schedule: ScheduleOptions;
  private readonly transcript: TranscriptOptions;
  private readonly evidence: EvidenceMatchOptions;
  private readonly latencyNow: () => number;
  private readonly stableContext: string;
  private readonly ledger: GapLedger;

  private readonly segments: TranscriptSegment[] = [];
  private readonly arrivals: number[] = [];
  private readonly index = new TranscriptIndex();
  private analysedCount = 0;
  /** Segment count at the end of each successful run; each run's speech becomes one cached history block. */
  private readonly analysedUpTo: number[] = [];
  private heldBack: HeldBackRaise[] = [];
  private consecutiveFailures = 0;
  private pendingWords = 0;
  private lastRunStartedAtMs = -Infinity;
  private retryNotBeforeMs = -Infinity;
  private running: Promise<RunRecord> | null = null;
  private runCount = 0;
  private readonly runs: RunRecord[] = [];
  private readonly runListeners = new Set<RunListener>();

  constructor(options: GapEngineOptions) {
    this.model = options.model;
    this.clock = options.clock ?? meetingClock();
    this.schedule = { ...DEFAULT_SCHEDULE, ...options.schedule };
    this.transcript = { ...DEFAULT_TRANSCRIPT_OPTIONS, ...options.transcript };
    this.evidence = { ...DEFAULT_EVIDENCE_MATCH, ...options.evidence };
    this.latencyNow = options.latencyNow ?? (() => Date.now());
    this.stableContext = buildStableContext(options.brief ?? {});
    this.ledger = new GapLedger(options.ledger);
  }

  /** Buffer a finalised transcript segment; starts a run if one is now due. */
  addSegment(segment: TranscriptSegment): void {
    const text = segment.text.trim();
    if (text.length === 0) return;
    const stored = { ...segment, text };
    this.segments.push(stored);
    this.arrivals.push(this.clock.now());
    this.index.add(stored);
    this.pendingWords += wordCount(text);
    this.tick();
  }

  /**
   * Expire stale items and start a run if one is due. Returns the run's
   * promise when one starts, otherwise null. Call periodically (see
   * RealtimeGapDriver) so the max-wait rule and staleness fire in silence.
   */
  tick(): Promise<RunRecord> | null {
    this.ledger.expireStale(this.clock.now());
    const trigger = this.dueTrigger();
    return trigger ? this.startRun(trigger) : null;
  }

  /** Force a final run over any unanalysed speech (end of meeting or replay). */
  async flush(): Promise<RunRecord | null> {
    // Inline rather than whenIdle(): with nothing in flight this reaches
    // startRun() synchronously, so a second flush() or addSegment() in the
    // same turn sees the run and cannot start another.
    while (this.running) await this.running;
    this.ledger.expireStale(this.clock.now());
    if (this.analysedCount >= this.segments.length) return null;
    return this.startRun('flush');
  }

  /** Resolves once no run is in progress, including runs chained after one finishes. */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  dismiss(id: string): boolean {
    return this.ledger.dismiss(id, this.clock.now());
  }

  restore(id: string): boolean {
    return this.ledger.restore(id, this.clock.now());
  }

  markResolved(id: string): boolean {
    return this.ledger.markResolved(id, this.clock.now());
  }

  snapshot(): GapSnapshot {
    return this.ledger.snapshot();
  }

  items(): GapItem[] {
    return this.ledger.all();
  }

  runLog(): RunRecord[] {
    return [...this.runs];
  }

  subscribe(listener: GapEventListener): () => void {
    return this.ledger.subscribe(listener);
  }

  onRun(listener: RunListener): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  private dueTrigger(): RunTrigger | null {
    if (this.running || this.analysedCount >= this.segments.length) return null;
    const now = this.clock.now();
    if (now < this.retryNotBeforeMs) return null;
    if (now - this.arrivals[this.analysedCount] >= this.schedule.maxWaitMs) return 'max_wait';
    if (
      this.pendingWords >= this.schedule.minNewWords &&
      now - this.lastRunStartedAtMs >= this.schedule.minIntervalMs
    ) {
      return 'new_words';
    }
    return null;
  }

  private startRun(trigger: RunTrigger): Promise<RunRecord> {
    if (this.running) return this.running;
    const atMs = this.clock.now();
    this.lastRunStartedAtMs = atMs;
    const runIndex = this.runCount++;
    const snapshotEnd = this.segments.length;
    const newWordCount = this.pendingWords;
    const turn = buildTurn(
      {
        bigIdeas: this.ledger.getBigIdeas(),
        items: this.ledger.all(),
        segments: this.segments.slice(0, snapshotEnd),
        analysedUpTo: [...this.analysedUpTo],
        heldBack: this.heldBack,
        nowMs: atMs,
      },
      this.transcript,
    );
    const input: AnalyzeInput = {
      system: GAP_SYSTEM_PROMPT,
      stableContext: this.stableContext,
      history: turn.history,
      turn: turn.text,
    };

    const run = async (): Promise<RunRecord> => {
      const record: RunRecord = {
        runIndex,
        trigger,
        atMs,
        completedAtMs: atMs,
        newWordCount,
        newSegmentCount: snapshotEnd - this.analysedCount,
        transcriptRange: turn.transcriptRange,
        inputSizes: {
          systemChars: input.system.length,
          stableContextChars: input.stableContext.length,
          historyChars: input.history.reduce((total, block) => total + block.length, 0),
          turnChars: input.turn.length,
        },
        accepted: [],
        rejected: [],
        latencyMs: 0,
      };

      const started = this.latencyNow();
      try {
        const output = await this.model.analyze(input);
        record.latencyMs = this.latencyNow() - started;
        record.completedAtMs = this.clock.now();
        record.usage = output.usage;
        if (output.ok) {
          record.rawOutput = output.output;
          record.model = output.model;
          this.markAnalysed(snapshotEnd);
          const applied = this.ledger.apply(parseModelOutput(output.output), record.completedAtMs, (quote) =>
            this.index.find(quote, this.evidence),
          );
          record.accepted = applied.accepted;
          record.rejected = applied.rejected;
          this.heldBack = heldBackRaises(applied.rejected);
        } else {
          record.error = output.error;
        }
      } catch (error) {
        record.latencyMs = this.latencyNow() - started;
        record.completedAtMs = this.clock.now();
        record.error = { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
      }

      // A failed run leaves its speech unanalysed for the next run, but waits
      // before retrying so an outage does not turn into a tight retry loop.
      if (record.error) {
        this.consecutiveFailures++;
        this.retryNotBeforeMs = record.completedAtMs + this.retryDelay();
      } else {
        this.consecutiveFailures = 0;
      }

      this.runs.push(record);
      this.running = null;
      for (const listener of this.runListeners) notifySafely(listener, record);
      this.tick();
      return record;
    };

    const promise = run();
    this.running = promise;
    return promise;
  }

  private retryDelay(): number {
    const base = Math.max(MIN_RETRY_DELAY_MS, this.schedule.minIntervalMs, this.schedule.retryDelayMs);
    return Math.min(MAX_RETRY_DELAY_MS, base * 2 ** (this.consecutiveFailures - 1));
  }

  private markAnalysed(upTo: number): void {
    this.analysedCount = upTo;
    this.analysedUpTo.push(upTo);
    this.pendingWords = 0;
    for (let i = upTo; i < this.segments.length; i++) this.pendingWords += wordCount(this.segments[i].text);
  }
}

function heldBackRaises(rejected: RejectedOp[]): HeldBackRaise[] {
  const held: HeldBackRaise[] = [];
  for (const rejection of rejected) {
    const op = rejection.op as { op?: unknown; question?: unknown } | null;
    if (op?.op === 'raise' && typeof op.question === 'string' && HELD_BACK_REASONS.has(rejection.reason)) {
      held.push({ question: op.question, reason: rejection.reason });
    }
  }
  return held;
}
