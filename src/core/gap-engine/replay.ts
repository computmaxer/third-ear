/**
 * Offline replay of a recorded meeting through the real engine, for
 * iterating on suggestion quality without holding live meetings. The engine
 * runs on a virtual clock and every model call is awaited, so the timeline is
 * the same however long the model takes.
 */

import { ManualClock, type Clock } from './clock';
import { replayTranscript } from './drivers';
import { DEFAULT_SCHEDULE, type RunRecord, type ScheduleOptions } from './engine';
import { DEFAULT_LEDGER_OPTIONS, type LedgerOptions } from './ledger';
import type { AnalyzeInput, AnalyzeOutput, GapModel } from './model';
import { DEFAULT_TRANSCRIPT_OPTIONS, type TranscriptOptions } from './prompt';
import { scripted } from './scripted-model';
import { parseTimestamp } from './transcript-format';
import type { BigIdeas, GapItem, GapSnapshot, MeetingBrief, TranscriptSegment } from './types';

export class OfflineScriptError extends Error {}

export interface TimedResponse {
  /** Meeting time from which this response may be used. */
  atMs: number;
  /** Raw model output, exactly as a model would return it. */
  output: unknown;
}

/**
 * Parses an offline script: {"responses": [{"at": "mm:ss", "output": {...}}]}.
 * Responses must be in time order. Other keys (such as "note") are ignored,
 * so a script can explain itself.
 */
export function parseOfflineScript(content: string): TimedResponse[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new OfflineScriptError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const responses = (data as { responses?: unknown } | null)?.responses;
  if (!Array.isArray(responses)) throw new OfflineScriptError('expected an object with a "responses" array');

  let previousMs = 0;
  return responses.map((entry, index) => {
    const where = `responses[${index}]`;
    if (typeof entry !== 'object' || entry === null) throw new OfflineScriptError(`${where}: not an object`);
    const { at, output } = entry as Record<string, unknown>;
    const atMs = typeof at === 'string' ? parseTimestamp(at) : null;
    if (atMs === null) throw new OfflineScriptError(`${where}: "at" must be a "mm:ss" or "hh:mm:ss" string`);
    if (atMs < previousMs) throw new OfflineScriptError(`${where}: responses must be in time order`);
    if (output === undefined) throw new OfflineScriptError(`${where}: "output" is missing`);
    previousMs = atMs;
    return { atMs, output };
  });
}

/** A run with no scripted response due changes nothing, big ideas included. */
const NO_OPERATIONS = { raise: [], resolve: [], update: [], drop: [] };

/**
 * A GapModel that answers from a timed script. Each response is used by the
 * first run that starts at or after its time; if two fall due before one
 * run, the later one waits for the next run. Keying responses to meeting time
 * rather than run number keeps a script valid when scheduling options change.
 */
export class TimedScriptModel implements GapModel {
  private next = 0;

  constructor(
    private readonly responses: TimedResponse[],
    private readonly clock: Clock,
  ) {}

  async analyze(): Promise<AnalyzeOutput> {
    const response = this.responses[this.next];
    if (response && response.atMs <= this.clock.now()) {
      this.next++;
      return scripted(response.output);
    }
    return scripted(NO_OPERATIONS);
  }

  /** Responses no run reached, usually because the transcript ended first. */
  unused(): TimedResponse[] {
    return this.responses.slice(this.next);
  }
}

export interface ReplaySettings {
  schedule: ScheduleOptions;
  ledger: LedgerOptions;
  transcript: TranscriptOptions;
}

export type TimelineEntry =
  | { type: 'speech'; atMs: number; segment: TranscriptSegment }
  | {
      type: 'run';
      atMs: number;
      run: RunRecord;
      /** Every item as it stood when the run finished. */
      items: GapItem[];
      bigIdeasBefore: BigIdeas;
    }
  | { type: 'stale'; atMs: number; item: GapItem };

export interface ReplayOptions {
  segments: TranscriptSegment[];
  model: GapModel;
  /** Pass the clock when the model reads it (TimedScriptModel). */
  clock?: ManualClock;
  brief?: MeetingBrief;
  schedule?: Partial<ScheduleOptions>;
  ledger?: Partial<LedgerOptions>;
  transcript?: Partial<TranscriptOptions>;
  /** Called as each timeline entry happens, for progress output. */
  onEntry?: (entry: TimelineEntry) => void;
}

export interface ReplayReport {
  settings: ReplaySettings;
  segments: TranscriptSegment[];
  entries: TimelineEntry[];
  runs: RunRecord[];
  /** The model input of each run, in run order. */
  inputs: AnalyzeInput[];
  items: GapItem[];
  snapshot: GapSnapshot;
}

/** The engine defaults with any overrides applied. */
export function resolveSettings(overrides: Pick<ReplayOptions, 'schedule' | 'ledger' | 'transcript'>): ReplaySettings {
  return {
    schedule: { ...DEFAULT_SCHEDULE, ...overrides.schedule },
    ledger: { ...DEFAULT_LEDGER_OPTIONS, ...overrides.ledger },
    transcript: { ...DEFAULT_TRANSCRIPT_OPTIONS, ...overrides.transcript },
  };
}

export async function runReplay(options: ReplayOptions): Promise<ReplayReport> {
  const settings = resolveSettings(options);
  const entries: TimelineEntry[] = [];
  const record = (entry: TimelineEntry) => {
    entries.push(entry);
    options.onEntry?.(entry);
  };

  const inputs: AnalyzeInput[] = [];
  const recordingModel: GapModel = {
    analyze: (input) => {
      inputs.push(input);
      return options.model.analyze(input);
    },
  };

  let bigIdeasBefore: BigIdeas = [];
  const result = await replayTranscript(
    options.segments,
    { model: recordingModel, brief: options.brief, ...settings },
    {
      clock: options.clock,
      onSegment: (segment) => record({ type: 'speech', atMs: segment.endMs, segment }),
      onEngine: (engine) => {
        engine.subscribe((event) => {
          if (event.type !== 'expired' || !event.itemId) return;
          const item = engine.items().find((candidate) => candidate.id === event.itemId);
          // Displaced and dropped items are reported with the run that caused them.
          if (item?.expiredReason === 'stale') record({ type: 'stale', atMs: event.atMs, item });
        });
        engine.onRun((run) => {
          record({ type: 'run', atMs: run.atMs, run, items: engine.items(), bigIdeasBefore });
          bigIdeasBefore = engine.snapshot().bigIdeas;
        });
      },
    },
  );

  return {
    settings,
    segments: options.segments,
    entries,
    runs: result.runs,
    inputs,
    items: result.engine.items(),
    snapshot: result.snapshot,
  };
}
