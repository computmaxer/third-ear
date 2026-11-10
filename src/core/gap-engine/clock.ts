/** Meeting-relative time source. Injected so tests and replays control time. */
export interface Clock {
  now(): number;
}

/** Real time measured from the moment the meeting started. */
export function meetingClock(startedAtEpochMs: number = Date.now()): Clock {
  return { now: () => Date.now() - startedAtEpochMs };
}

/** A clock that only moves when told to; for tests and offline replay. */
export class ManualClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
