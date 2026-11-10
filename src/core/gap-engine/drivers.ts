/**
 * Ways to drive a GapEngine through time: a real-time ticker for live
 * meetings and an instant replay of a recorded transcript.
 */

import { ManualClock } from './clock';
import { GapEngine, type GapEngineOptions, type RunRecord } from './engine';
import type { GapSnapshot, TranscriptSegment } from './types';

/** Ticks the engine on a timer so max-wait runs and staleness fire during silence. */
export class RealtimeGapDriver {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: GapEngine,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.engine.tick(), this.intervalMs);
  }

  /** Stops ticking and runs a final analysis over any unanalysed speech. */
  async stop(): Promise<RunRecord | null> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.engine.flush();
  }
}

export interface ReplayResult {
  engine: GapEngine;
  runs: RunRecord[];
  snapshot: GapSnapshot;
}

export interface ReplayDriverOptions {
  /** Step size for advancing the clock through silences. */
  tickMs?: number;
  /** Supply the clock when something else (such as a scripted model) must read it. */
  clock?: ManualClock;
  /** Called once with the new engine, before any segment is fed. */
  onEngine?: (engine: GapEngine) => void;
  /** Called just before each segment reaches the engine. */
  onSegment?: (segment: TranscriptSegment) => void;
}

/**
 * Replays a recorded transcript through a fresh engine as fast as the model
 * answers. Each segment arrives at its endMs (when speech recognition would
 * finalise it), and the clock steps through silences in tickMs increments
 * so time-based rules behave as they would live. Every run is awaited, so
 * the result does not depend on model latency.
 */
export async function replayTranscript(
  segments: TranscriptSegment[],
  options: Omit<GapEngineOptions, 'clock'>,
  driver: ReplayDriverOptions = {},
): Promise<ReplayResult> {
  const tickMs = driver.tickMs ?? 1000;
  const clock = driver.clock ?? new ManualClock(0);
  const engine = new GapEngine({ ...options, clock });
  driver.onEngine?.(engine);
  const ordered = [...segments].sort((a, b) => a.endMs - b.endMs);

  for (const segment of ordered) {
    while (clock.now() + tickMs < segment.endMs) {
      clock.advance(tickMs);
      engine.tick();
      await engine.whenIdle();
    }
    clock.set(Math.max(clock.now(), segment.endMs));
    driver.onSegment?.(segment);
    engine.addSegment(segment);
    await engine.whenIdle();
  }
  await engine.flush();
  await engine.whenIdle();

  return { engine, runs: engine.runLog(), snapshot: engine.snapshot() };
}
