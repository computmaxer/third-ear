/**
 * The gap ledger: the engine's memory of every gap raised in a meeting and
 * the rules that decide which model suggestions reach the user. These rules
 * are the product's precision guarantees, so they live in plain code rather
 * than in the prompt.
 */

import type { ItemOp, ParsedOutput, QuotedEvidence, RaiseOp, RejectedOp } from './operations';
import { notifySafely } from './notify';
import { contentContainment, lexicalSimilarity, wordContainment, type EvidenceMatch } from './text';
import type {
  BigIdeas,
  Evidence,
  GapEvent,
  GapEventListener,
  GapEventType,
  GapItem,
  GapSnapshot,
} from './types';

export interface LedgerOptions {
  /** Raises below this importance are dropped. */
  importanceFloor: number;
  /** Maximum number of open items shown to the user at once. */
  maxOpen: number;
  maxRaisesPerRun: number;
  /** After an accepted raise, further raises wait this long unless importance is 5. */
  raiseCooldownMs: number;
  /** Open items untouched for this long expire. */
  staleAfterMs: number;
  /** Questions at or above this content-word similarity count as duplicates. */
  duplicateSimilarity: number;
}

/**
 * Two evidence quotes from the same segment are the same statement when this
 * share of the smaller quote's content words appear in the other.
 */
const SAME_EVIDENCE_CONTAINMENT = 0.6;
/** A resolve quote this contained in the item's own evidence restates the gap instead of answering it. */
const RESTATED_EVIDENCE_CONTAINMENT = 0.8;

/** Expired without an answer: taken off the live list by staleness or displacement. */
export function isRetiredUnanswered(item: GapItem): boolean {
  return item.status === 'expired' && (item.expiredReason === 'stale' || item.expiredReason === 'displaced');
}

export const DEFAULT_LEDGER_OPTIONS: LedgerOptions = {
  importanceFloor: 3,
  maxOpen: 3,
  maxRaisesPerRun: 1,
  raiseCooldownMs: 60_000,
  staleAfterMs: 12 * 60_000,
  duplicateSimilarity: 0.5,
};

export type FindEvidence = (quote: string) => EvidenceMatch | null;

export interface AcceptedOp {
  op: ItemOp | { op: 'big_ideas'; bigIdeas: BigIdeas };
  itemId?: string;
  /** Set when a raise pushed out a less important open item. */
  displacedId?: string;
  /** Set when a raise brought back a retired unanswered item instead of creating one. */
  reopened?: boolean;
}

export interface ApplyResult {
  accepted: AcceptedOp[];
  rejected: RejectedOp[];
}

const OP_ORDER: Record<ItemOp['op'], number> = { resolve: 0, drop: 1, update: 2, raise: 3 };

export class GapLedger {
  private readonly options: LedgerOptions;
  private readonly items = new Map<string, GapItem>();
  private readonly listeners = new Set<GapEventListener>();
  private bigIdeas: BigIdeas = [];
  private nextId = 1;
  private lastRaiseAcceptedAtMs: number | null = null;

  constructor(options: Partial<LedgerOptions> = {}) {
    this.options = { ...DEFAULT_LEDGER_OPTIONS, ...options };
  }

  subscribe(listener: GapEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(id: string): GapItem | undefined {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): GapItem[] {
    return [...this.items.values()].map((item) => structuredClone(item));
  }

  getBigIdeas(): BigIdeas {
    return [...this.bigIdeas];
  }

  snapshot(): GapSnapshot {
    const all = this.all();
    return {
      open: all
        .filter((item) => item.status === 'open')
        .sort((a, b) => b.importance - a.importance || a.raisedAtMs - b.raisedAtMs),
      resolved: all.filter((item) => item.status === 'resolved').sort((a, b) => b.updatedAtMs - a.updatedAtMs),
      unanswered: all.filter(isRetiredUnanswered).sort((a, b) => b.updatedAtMs - a.updatedAtMs),
      bigIdeas: this.getBigIdeas(),
    };
  }

  /** Apply one run's parsed model output. Rejections from parsing are carried through. */
  apply(parsed: ParsedOutput, nowMs: number, findEvidence: FindEvidence): ApplyResult {
    const result: ApplyResult = { accepted: [], rejected: [...parsed.rejected] };
    const ordered = [...parsed.ops].sort((a, b) => {
      const byOp = OP_ORDER[a.op] - OP_ORDER[b.op];
      if (byOp !== 0) return byOp;
      return a.op === 'raise' && b.op === 'raise' ? b.importance - a.importance : 0;
    });

    let raisesThisRun = 0;
    for (const op of ordered) {
      if (op.op === 'raise') {
        if (raisesThisRun >= this.options.maxRaisesPerRun) {
          result.rejected.push({ op, reason: 'max_raises_per_run' });
          continue;
        }
        if (this.applyRaise(op, nowMs, findEvidence, result)) raisesThisRun++;
      } else {
        this.applyToExisting(op, nowMs, findEvidence, result);
      }
    }

    // An empty list never replaces a non-empty one: it is far more likely to be
    // a "nothing to report" reply than a decision to forget the whole meeting.
    if (parsed.bigIdeas && parsed.bigIdeas.length > 0 && !sameList(parsed.bigIdeas, this.bigIdeas)) {
      this.bigIdeas = [...parsed.bigIdeas];
      result.accepted.push({ op: { op: 'big_ideas', bigIdeas: this.getBigIdeas() } });
      this.emit('big_ideas', nowMs);
    }
    return result;
  }

  /** Expire open items nobody has touched for staleAfterMs. Returns the expired ids. */
  expireStale(nowMs: number): string[] {
    const expired: string[] = [];
    for (const item of this.items.values()) {
      if (item.status === 'open' && nowMs - item.updatedAtMs >= this.options.staleAfterMs) {
        this.expire(item, 'stale', nowMs);
        expired.push(item.id);
      }
    }
    return expired;
  }

  dismiss(id: string, nowMs: number): boolean {
    const item = this.items.get(id);
    if (!item || item.status !== 'open') return false;
    item.status = 'dismissed';
    item.updatedAtMs = nowMs;
    this.emit('dismissed', nowMs, id);
    return true;
  }

  /** Bring a dismissed, resolved or expired item back to open. The user's choice overrides the budget. */
  restore(id: string, nowMs: number): boolean {
    const item = this.items.get(id);
    if (!item || item.status === 'open') return false;
    item.status = 'open';
    item.updatedAtMs = nowMs;
    delete item.resolution;
    delete item.expiredReason;
    this.emit('restored', nowMs, id);
    return true;
  }

  markResolved(id: string, nowMs: number): boolean {
    const item = this.items.get(id);
    if (!item || item.status !== 'open') return false;
    item.status = 'resolved';
    item.updatedAtMs = nowMs;
    item.resolution = { how: 'Marked resolved by the user', evidence: [] };
    this.emit('resolved', nowMs, id);
    return true;
  }

  private applyRaise(op: RaiseOp, nowMs: number, findEvidence: FindEvidence, result: ApplyResult): boolean {
    const reject = (reason: RejectedOp['reason'], detail?: string): false => {
      result.rejected.push({ op, reason, detail });
      return false;
    };

    if (op.importance < this.options.importanceFloor) {
      return reject('below_importance_floor', `importance ${op.importance} < ${this.options.importanceFloor}`);
    }
    // Unverifiable quotes are dropped: one real quote is enough, and the other
    // side of a contradiction may be quoted from memory.
    const verified = op.evidence.map((quote) => verify(quote, findEvidence));
    const evidence = verified.filter((entry): entry is Evidence => typeof entry !== 'string');
    if (evidence.length === 0) return reject('evidence_not_found', verified[0] as string);

    // A re-raise of a gap nearly always quotes the same statement, however the question is worded.
    for (const existing of this.items.values()) {
      if (sameStatements(evidence, existing.evidence, op.kind === existing.kind)) {
        return reject('duplicate', `same evidence as ${existing.id} (${existing.status})`);
      }
    }
    const similar = this.findSimilarQuestion(op.question);
    if (similar && !isRetiredUnanswered(similar.item)) {
      return reject('duplicate', `near ${similar.item.id} (${similar.item.status}, similarity ${similar.similarity.toFixed(2)})`);
    }
    // A retired unanswered gap raised again from new speech means the group came back to it.
    const reopen = similar?.item;

    if (
      this.lastRaiseAcceptedAtMs !== null &&
      nowMs - this.lastRaiseAcceptedAtMs < this.options.raiseCooldownMs &&
      op.importance < 5
    ) {
      return reject('cooldown', `${nowMs - this.lastRaiseAcceptedAtMs}ms since last raise`);
    }

    let displaced: GapItem | undefined;
    const open = [...this.items.values()].filter((item) => item.status === 'open');
    if (open.length >= this.options.maxOpen) {
      const weakest = open.reduce((a, b) =>
        b.importance < a.importance || (b.importance === a.importance && b.updatedAtMs < a.updatedAtMs) ? b : a,
      );
      if (op.importance <= weakest.importance) {
        return reject('over_budget', `weakest open item ${weakest.id} has importance ${weakest.importance}`);
      }
      displaced = weakest;
    }

    if (displaced) this.expire(displaced, 'displaced', nowMs);
    this.lastRaiseAcceptedAtMs = nowMs;
    if (reopen) {
      reopen.status = 'open';
      delete reopen.expiredReason;
      reopen.importance = op.importance;
      reopen.evidence = [...reopen.evidence, ...evidence];
      reopen.updatedAtMs = nowMs;
      result.accepted.push({ op, itemId: reopen.id, displacedId: displaced?.id, reopened: true });
      this.emit('restored', nowMs, reopen.id);
      return true;
    }
    const item: GapItem = {
      id: `g${this.nextId++}`,
      kind: op.kind,
      question: op.question,
      why: op.why,
      evidence,
      importance: op.importance,
      status: 'open',
      raisedAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.items.set(item.id, item);
    result.accepted.push({ op, itemId: item.id, displacedId: displaced?.id });
    this.emit('raised', nowMs, item.id);
    return true;
  }

  private applyToExisting(
    op: Exclude<ItemOp, RaiseOp>,
    nowMs: number,
    findEvidence: FindEvidence,
    result: ApplyResult,
  ): void {
    const item = this.items.get(op.id);
    if (!item) {
      result.rejected.push({ op, reason: 'unknown_id' });
      return;
    }
    if (item.status !== 'open') {
      result.rejected.push({ op, reason: 'not_open', detail: `${item.id} is ${item.status}` });
      return;
    }

    switch (op.op) {
      case 'resolve': {
        const evidence = verify(op.evidence, findEvidence);
        if (typeof evidence === 'string') {
          result.rejected.push({ op, reason: 'evidence_not_found', detail: evidence });
          return;
        }
        const restated = item.evidence.find(
          (raised) =>
            raised.atMs === evidence.atMs && wordContainment(evidence.quote, raised.quote) >= RESTATED_EVIDENCE_CONTAINMENT,
        );
        if (restated) {
          result.rejected.push({ op, reason: 'not_an_answer', detail: `quotes the evidence that raised ${item.id}` });
          return;
        }
        item.status = 'resolved';
        item.updatedAtMs = nowMs;
        item.resolution = { how: op.how, evidence: [evidence] };
        result.accepted.push({ op, itemId: item.id });
        this.emit('resolved', nowMs, item.id);
        return;
      }
      case 'drop':
        this.expire(item, `moot: ${op.reason}`, nowMs);
        result.accepted.push({ op, itemId: item.id });
        return;
      case 'update': {
        const changed =
          (op.question !== undefined && op.question !== item.question) ||
          (op.why !== undefined && op.why !== item.why) ||
          (op.importance !== undefined && op.importance !== item.importance);
        if (!changed) {
          result.rejected.push({ op, reason: 'empty_update' });
          return;
        }
        if (op.question !== undefined && op.question !== item.question) {
          const similar = this.findSimilarQuestion(op.question, item.id);
          if (similar) {
            result.rejected.push({
              op,
              reason: 'duplicate',
              detail: `near ${similar.item.id} (${similar.item.status}, similarity ${similar.similarity.toFixed(2)})`,
            });
            return;
          }
        }
        if (op.question !== undefined) item.question = op.question;
        if (op.why !== undefined) item.why = op.why;
        if (op.importance !== undefined) item.importance = op.importance;
        item.updatedAtMs = nowMs;
        result.accepted.push({ op, itemId: item.id });
        this.emit('updated', nowMs, item.id);
        return;
      }
    }
  }

  /** The first item (any status, other than `excludeId`) whose question is a near-duplicate. */
  private findSimilarQuestion(question: string, excludeId?: string): { item: GapItem; similarity: number } | null {
    for (const item of this.items.values()) {
      if (item.id === excludeId) continue;
      const similarity = lexicalSimilarity(question, item.question);
      if (similarity >= this.options.duplicateSimilarity) return { item, similarity };
    }
    return null;
  }

  private expire(item: GapItem, reason: string, nowMs: number): void {
    item.status = 'expired';
    item.expiredReason = reason;
    item.updatedAtMs = nowMs;
    this.emit('expired', nowMs, item.id);
  }

  private emit(type: GapEventType, atMs: number, itemId?: string): void {
    if (this.listeners.size === 0) return;
    const event: GapEvent = { type, itemId, atMs, snapshot: this.snapshot() };
    for (const listener of this.listeners) notifySafely(listener, event);
  }
}

/** The verified evidence for a quote, or a description of why it failed. */
function verify(quote: QuotedEvidence, findEvidence: FindEvidence): Evidence | string {
  const match = findEvidence(quote.quote);
  if (!match) return `quote not in transcript: ${JSON.stringify(quote.quote)}`;
  return { speaker: match.speaker, quote: match.text, atMs: match.atMs };
}

/**
 * True when a raise quotes the same statements as an existing item: every
 * quote of `candidate` is in `existing` (same segment, mostly the same words),
 * and either the kind matches or `existing` quotes nothing else. A different
 * kind of gap built on one side of a contradiction is a new gap.
 */
function sameStatements(candidate: Evidence[], existing: Evidence[], sameKind: boolean): boolean {
  if (existing.length === 0 || !covers(existing, candidate)) return false;
  return sameKind || covers(candidate, existing);
}

/** Every quote of `quotes` is the same statement as one in `by`. */
function covers(by: Evidence[], quotes: Evidence[]): boolean {
  return quotes.every((quote) =>
    by.some((other) => other.atMs === quote.atMs && contentContainment(quote.quote, other.quote) >= SAME_EVIDENCE_CONTAINMENT),
  );
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
