/**
 * The operations a model returns on each analysis run, and a strict parser
 * that turns untrusted model output into typed operations. Anything
 * malformed is dropped with a recorded reason rather than guessed at.
 */

import { GAP_KINDS, type GapKind } from './types';

export interface QuotedEvidence {
  speaker: string;
  quote: string;
}

export interface RaiseOp {
  op: 'raise';
  kind: GapKind;
  question: string;
  why: string;
  evidence: QuotedEvidence[];
  importance: number;
}

export interface ResolveOp {
  op: 'resolve';
  id: string;
  how: string;
  evidence: QuotedEvidence;
}

export interface UpdateOp {
  op: 'update';
  id: string;
  question?: string;
  why?: string;
  importance?: number;
}

export interface DropOp {
  op: 'drop';
  id: string;
  reason: string;
}

export type ItemOp = RaiseOp | ResolveOp | UpdateOp | DropOp;

export type RejectionReason =
  | 'malformed'
  | 'evidence_not_found'
  | 'below_importance_floor'
  | 'over_budget'
  | 'max_raises_per_run'
  | 'duplicate'
  | 'cooldown'
  | 'unknown_id'
  | 'not_open'
  | 'empty_update'
  | 'not_an_answer';

export interface RejectedOp {
  /** The operation as the model sent it (possibly malformed). */
  op: unknown;
  reason: RejectionReason;
  detail?: string;
}

export interface ParsedOutput {
  ops: ItemOp[];
  /** Full replacement list, or undefined when the model sent none (keep the current one). */
  bigIdeas?: string[];
  rejected: RejectedOp[];
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const importanceSchema = { type: 'integer', enum: [1, 2, 3, 4, 5] };
const quoteSchema = {
  type: 'object',
  properties: { speaker: { type: 'string' }, quote: { type: 'string' } },
  required: ['speaker', 'quote'],
  additionalProperties: false,
};

/**
 * JSON Schema for the model's reply, for providers that can enforce one.
 * It uses only widely supported keywords (no numeric or length limits);
 * parseModelOutput enforces the rest.
 */
export const GAP_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    raise: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...GAP_KINDS] },
          question: { type: 'string' },
          why: { type: 'string' },
          evidence: { type: 'array', items: quoteSchema },
          importance: importanceSchema,
        },
        required: ['kind', 'question', 'why', 'evidence', 'importance'],
        additionalProperties: false,
      },
    },
    resolve: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, how: { type: 'string' }, evidence: quoteSchema },
        required: ['id', 'how', 'evidence'],
        additionalProperties: false,
      },
    },
    update: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: nullableString,
          why: nullableString,
          importance: { anyOf: [importanceSchema, { type: 'null' }] },
        },
        required: ['id', 'question', 'why', 'importance'],
        additionalProperties: false,
      },
    },
    drop: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
    bigIdeas: { type: 'array', items: { type: 'string' } },
  },
  required: ['raise', 'resolve', 'update', 'drop', 'bigIdeas'],
  additionalProperties: false,
};

export const MAX_BIG_IDEAS = 6;
const MAX_QUESTION_CHARS = 400;
const MAX_EVIDENCE_PER_RAISE = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxChars = MAX_QUESTION_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxChars ? trimmed : null;
}

/** null and absent both mean "not provided"; anything else must be valid. */
function optionalText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return text(value);
}

function importance(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

function evidence(value: unknown): QuotedEvidence | null {
  if (!isRecord(value)) return null;
  const speaker = typeof value.speaker === 'string' ? value.speaker.trim() : '';
  const quote = text(value.quote, 1000);
  return quote ? { speaker, quote } : null;
}

function parseRaise(raw: unknown): RaiseOp | string {
  if (!isRecord(raw)) return 'raise is not an object';
  if (typeof raw.kind !== 'string' || !(GAP_KINDS as readonly string[]).includes(raw.kind)) {
    return `unknown kind ${JSON.stringify(raw.kind)}`;
  }
  const question = text(raw.question);
  if (!question) return 'question missing or too long';
  const why = text(raw.why);
  if (!why) return 'why missing or too long';
  const level = importance(raw.importance);
  if (level === null) return 'importance must be an integer 1-5';
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) return 'evidence must be a non-empty array';
  if (raw.evidence.length > MAX_EVIDENCE_PER_RAISE) return `at most ${MAX_EVIDENCE_PER_RAISE} evidence quotes`;
  const quotes: QuotedEvidence[] = [];
  for (const item of raw.evidence) {
    const parsed = evidence(item);
    if (!parsed) return 'evidence entries need a non-empty quote';
    quotes.push(parsed);
  }
  return { op: 'raise', kind: raw.kind as GapKind, question, why, evidence: quotes, importance: level };
}

function parseResolve(raw: unknown): ResolveOp | string {
  if (!isRecord(raw)) return 'resolve is not an object';
  const id = text(raw.id, 40);
  if (!id) return 'id missing';
  const how = text(raw.how);
  if (!how) return 'how missing or too long';
  const quote = evidence(raw.evidence);
  if (!quote) return 'evidence must be an object with a quote';
  return { op: 'resolve', id, how, evidence: quote };
}

function parseUpdate(raw: unknown): UpdateOp | string {
  if (!isRecord(raw)) return 'update is not an object';
  const id = text(raw.id, 40);
  if (!id) return 'id missing';
  const question = optionalText(raw.question);
  if (question === null) return 'question must be a non-empty string';
  const why = optionalText(raw.why);
  if (why === null) return 'why must be a non-empty string';
  let level: number | undefined;
  if (raw.importance !== undefined && raw.importance !== null) {
    const parsed = importance(raw.importance);
    if (parsed === null) return 'importance must be an integer 1-5';
    level = parsed;
  }
  const op: UpdateOp = { op: 'update', id };
  if (question !== undefined) op.question = question;
  if (why !== undefined) op.why = why;
  if (level !== undefined) op.importance = level;
  return op;
}

function parseDrop(raw: unknown): DropOp | string {
  if (!isRecord(raw)) return 'drop is not an object';
  const id = text(raw.id, 40);
  if (!id) return 'id missing';
  const reason = text(raw.reason);
  if (!reason) return 'reason missing';
  return { op: 'drop', id, reason };
}

const PARSERS: Record<ItemOp['op'], (raw: unknown) => ItemOp | string> = {
  raise: parseRaise,
  resolve: parseResolve,
  update: parseUpdate,
  drop: parseDrop,
};

export function parseModelOutput(raw: unknown): ParsedOutput {
  const result: ParsedOutput = { ops: [], rejected: [] };
  if (!isRecord(raw)) {
    result.rejected.push({ op: raw, reason: 'malformed', detail: 'output is not a JSON object' });
    return result;
  }

  for (const key of Object.keys(PARSERS) as ItemOp['op'][]) {
    const list = raw[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      result.rejected.push({ op: list, reason: 'malformed', detail: `${key} must be an array` });
      continue;
    }
    for (const entry of list) {
      const parsed = PARSERS[key](entry);
      if (typeof parsed === 'string') result.rejected.push({ op: entry, reason: 'malformed', detail: parsed });
      else result.ops.push(parsed);
    }
  }

  if (raw.bigIdeas !== undefined && raw.bigIdeas !== null) {
    if (Array.isArray(raw.bigIdeas) && raw.bigIdeas.every((idea) => typeof idea === 'string')) {
      result.bigIdeas = (raw.bigIdeas as string[])
        .map((idea) => idea.trim())
        .filter((idea) => idea.length > 0)
        .slice(0, MAX_BIG_IDEAS);
    } else {
      result.rejected.push({ op: raw.bigIdeas, reason: 'malformed', detail: 'bigIdeas must be an array of strings' });
    }
  }

  return result;
}
