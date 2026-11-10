/**
 * Shared types for the gap engine: a meeting assistant that tracks what a
 * group has not pinned down yet (ambiguities, unaddressed topics,
 * contradictions, implicit decisions).
 *
 * All times are milliseconds relative to the start of the meeting.
 */

export interface TranscriptSegment {
  /** Free-form label: 'me', 'them', or a real name once diarization exists. */
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export const GAP_KINDS = ['ambiguity', 'unaddressed', 'contradiction', 'implicit_decision'] as const;
export type GapKind = (typeof GAP_KINDS)[number];

export type GapStatus = 'open' | 'resolved' | 'dismissed' | 'expired';

/** A transcript quote that the engine has verified against what it heard. */
export interface Evidence {
  speaker: string;
  quote: string;
  atMs: number;
}

export interface Resolution {
  how: string;
  evidence: Evidence[];
}

export interface GapItem {
  id: string;
  kind: GapKind;
  question: string;
  why: string;
  evidence: Evidence[];
  importance: number;
  status: GapStatus;
  raisedAtMs: number;
  updatedAtMs: number;
  resolution?: Resolution;
  /** Why an item is 'expired': 'stale', 'displaced', or 'moot: <model reason>'. */
  expiredReason?: string;
}

/** Rolling "big ideas so far" bullets; doubles as the model's long-term memory. */
export type BigIdeas = string[];

export interface ContextBlock {
  label: string;
  text: string;
}

export interface MeetingBrief {
  title?: string;
  brief?: string;
  /** Extra up-front context (files, project memory) rendered into the prompt. */
  contextBlocks?: ContextBlock[];
}

export interface GapSnapshot {
  open: GapItem[];
  resolved: GapItem[];
  /** Expired as stale or displaced: off the live list, but never answered. */
  unanswered: GapItem[];
  bigIdeas: BigIdeas;
}

export type GapEventType =
  | 'raised'
  | 'updated'
  | 'resolved'
  | 'expired'
  | 'dismissed'
  | 'restored'
  | 'big_ideas';

export interface GapEvent {
  type: GapEventType;
  itemId?: string;
  atMs: number;
  snapshot: GapSnapshot;
}

export type GapEventListener = (event: GapEvent) => void;
