/**
 * Text utilities for the ledger's precision guards: locating quoted evidence
 * in the transcript (tolerant of speech-recognition noise) and detecting
 * near-duplicate questions.
 */

import type { TranscriptSegment } from './types';

export interface Token {
  /** Lowercased, diacritic- and apostrophe-free form used for comparison. */
  norm: string;
  segmentIndex: number;
  start: number;
  end: number;
}

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

export function normalizeWord(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '');
}

export function tokenize(text: string, segmentIndex = -1): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const start = match.index ?? 0;
    tokens.push({
      norm: normalizeWord(match[0]),
      segmentIndex,
      start,
      end: start + match[0].length,
    });
  }
  return tokens;
}

export function wordCount(text: string): number {
  return tokenize(text).length;
}

/** True when the words are equal or one edit apart (for words of 4+ letters). */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export interface EvidenceMatchOptions {
  /** Fraction of quote words that must be found in a transcript window. */
  minOverlap: number;
  /** Quotes shorter than this are too weak to count as evidence. */
  minQuoteWords: number;
  /** Quotes with fewer non-filler words than this ("I think that") prove nothing. */
  minContentWords: number;
}

export const DEFAULT_EVIDENCE_MATCH: EvidenceMatchOptions = {
  minOverlap: 0.8,
  minQuoteWords: 3,
  minContentWords: 2,
};

export interface EvidenceMatch {
  /** The transcript's own words for the matched span. */
  text: string;
  speaker: string;
  atMs: number;
  exact: boolean;
  overlap: number;
}

/**
 * Searchable token stream over the whole meeting transcript. Rebuilt
 * incrementally as segments arrive.
 */
export class TranscriptIndex {
  private readonly tokens: Token[] = [];
  private readonly segments: TranscriptSegment[] = [];

  add(segment: TranscriptSegment): void {
    const index = this.segments.length;
    this.segments.push(segment);
    for (const token of tokenize(segment.text, index)) this.tokens.push(token);
  }

  find(quote: string, options: EvidenceMatchOptions = DEFAULT_EVIDENCE_MATCH): EvidenceMatch | null {
    const quoteWords = tokenize(quote).map((t) => t.norm);
    const m = quoteWords.length;
    if (m < options.minQuoteWords || this.tokens.length === 0) return null;
    const contentTotal = quoteWords.filter((word) => !STOPWORDS.has(word)).length;
    if (contentTotal < options.minContentWords) return null;

    const exactAt = this.findExact(quoteWords);
    if (exactAt >= 0) return this.toMatch(exactAt, exactAt + m - 1, true, 1);

    // Windows slightly longer than the quote absorb inserted filler words.
    const slack = Math.max(2, Math.ceil(m * 0.25));
    const windowSize = m + slack;
    let best: { first: number; last: number; overlap: number } | null = null;
    for (let start = 0; start < this.tokens.length; start++) {
      const end = Math.min(this.tokens.length, start + windowSize);
      const used = new Array<boolean>(end - start).fill(false);
      let matched = 0;
      let contentMatched = 0;
      let first = -1;
      let last = -1;
      for (const word of quoteWords) {
        for (let k = start; k < end; k++) {
          if (used[k - start] || !wordsMatch(word, this.tokens[k].norm)) continue;
          used[k - start] = true;
          matched++;
          if (!STOPWORDS.has(word)) contentMatched++;
          if (first < 0 || k < first) first = k;
          if (k > last) last = k;
          break;
        }
      }
      const overlap = matched / m;
      // Common filler words match almost anywhere, so the meaningful words must match too.
      const contentOverlap = contentMatched / contentTotal;
      if (overlap >= options.minOverlap && contentOverlap >= options.minOverlap && (!best || overlap > best.overlap)) {
        best = { first, last, overlap };
        if (overlap === 1) break;
      }
      if (end === this.tokens.length) break;
    }
    return best ? this.toMatch(best.first, best.last, false, best.overlap) : null;
  }

  private findExact(words: string[]): number {
    outer: for (let start = 0; start + words.length <= this.tokens.length; start++) {
      for (let k = 0; k < words.length; k++) {
        if (this.tokens[start + k].norm !== words[k]) continue outer;
      }
      return start;
    }
    return -1;
  }

  private toMatch(first: number, last: number, exact: boolean, overlap: number): EvidenceMatch {
    const firstToken = this.tokens[first];
    const lastToken = this.tokens[last];
    const parts: string[] = [];
    for (let s = firstToken.segmentIndex; s <= lastToken.segmentIndex; s++) {
      const text = this.segments[s].text;
      const from = s === firstToken.segmentIndex ? firstToken.start : 0;
      const to = s === lastToken.segmentIndex ? lastToken.end : text.length;
      parts.push(text.slice(from, to).trim());
    }
    const segment = this.segments[firstToken.segmentIndex];
    return {
      text: parts.join(' … '),
      speaker: segment.speaker,
      atMs: segment.startMs,
      exact,
      overlap,
    };
  }
}

const STOPWORDS = new Set(
  (
    'a an the and or but if then so of to in on at by for with from about into over under ' +
    'is are was were be been being do does did done has have had will would should could can may might must ' +
    'it its this that these those there here what which who whom whose when where why how ' +
    'we you they he she i me us our your their them his her my ' +
    'not no yes any all some each every more most other such than too very just also only ' +
    'as up out own same both few nor once again further s t'
  ).split(' '),
);

const SUFFIXES = ['ing', 'ed', 'es', 's'];

/** Crude suffix stripping so "payments"/"payment" and "closed"/"closes" compare equal. */
function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

export function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of tokenize(text)) {
    if (!STOPWORDS.has(token.norm)) words.add(stem(token.norm));
  }
  return words;
}

/** Fraction of the words of `part` that also occur in `whole` (0..1). */
export function wordContainment(part: string, whole: string): number {
  const partWords = new Set(tokenize(part).map((token) => token.norm));
  if (partWords.size === 0) return 0;
  const wholeWords = new Set(tokenize(whole).map((token) => token.norm));
  let shared = 0;
  for (const word of partWords) if (wholeWords.has(word)) shared++;
  return shared / partWords.size;
}

/** Shared content words as a fraction of the smaller text's content words (0..1). */
export function contentContainment(a: string, b: string): number {
  const wordsA = contentWords(a);
  const wordsB = contentWords(b);
  const smaller = Math.min(wordsA.size, wordsB.size);
  if (smaller === 0) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  return shared / smaller;
}

/** Jaccard similarity of the content words of two short texts (0..1). */
export function lexicalSimilarity(a: string, b: string): number {
  const wordsA = contentWords(a);
  const wordsB = contentWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  return shared / (wordsA.size + wordsB.size - shared);
}
