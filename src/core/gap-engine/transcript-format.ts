/**
 * Reading recorded transcripts for replay: a JSON array of TranscriptSegment,
 * or plain text lines of the form "[mm:ss] Speaker: text" ("[hh:mm:ss]" also
 * works). In the text form, lines starting with '#' are comments, blank lines
 * are ignored, and a line without a timestamp continues the previous line.
 */

import { wordCount } from './text';
import type { TranscriptSegment } from './types';

export class TranscriptFormatError extends Error {}

/** Typical conversational pace, used to estimate when a text-format line ends. */
const SPOKEN_MS_PER_WORD = 400;
const MIN_SEGMENT_MS = 1000;

/** Parses "mm:ss" or "hh:mm:ss" into milliseconds; returns null if malformed. */
export function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  const seconds = numbers[numbers.length - 1];
  if (seconds >= 60) return null;
  if (numbers.length === 3 && numbers[1] >= 60) return null;
  const totalSeconds = numbers.length === 3 ? numbers[0] * 3600 + numbers[1] * 60 + seconds : numbers[0] * 60 + seconds;
  return totalSeconds * 1000;
}

/** Detects the format from the content and parses it. */
export function parseTranscript(content: string): TranscriptSegment[] {
  const text = content.replace(/^\uFEFF/, '');
  return /^\s*\[\s*[{\]]/.test(text) ? parseJsonTranscript(text) : parseTextTranscript(text);
}

const LINE_PATTERN = /^\[([\d:]+)\]\s*([^:]+?)\s*:\s*(.*)$/;

export function parseTextTranscript(content: string): TranscriptSegment[] {
  const lines: { speaker: string; text: string; startMs: number }[] = [];
  content.split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) return;

    if (!line.startsWith('[')) {
      const previous = lines[lines.length - 1];
      if (!previous) throw new TranscriptFormatError(`line ${lineNumber}: expected "[mm:ss] Speaker: text"`);
      previous.text = `${previous.text} ${line}`.trim();
      return;
    }

    const match = LINE_PATTERN.exec(line);
    const startMs = match ? parseTimestamp(match[1]) : null;
    if (!match || startMs === null) {
      throw new TranscriptFormatError(`line ${lineNumber}: expected "[mm:ss] Speaker: text", got ${JSON.stringify(raw)}`);
    }
    const previous = lines[lines.length - 1];
    if (previous && startMs < previous.startMs) {
      throw new TranscriptFormatError(`line ${lineNumber}: timestamp [${match[1]}] is earlier than the line before it`);
    }
    lines.push({ speaker: match[2], text: match[3].trim(), startMs });
  });

  const nonEmpty = lines.filter((line) => line.text.length > 0);
  if (nonEmpty.length === 0) throw new TranscriptFormatError('no transcript lines found');
  return nonEmpty.map((line, i) => ({
    ...line,
    endMs: estimateEnd(line.startMs, line.text, nonEmpty[i + 1]?.startMs),
  }));
}

/**
 * Text lines carry only a start time. A line is taken to end when the next
 * one starts or after a typical speaking time for its words, whichever is
 * sooner, so a long silence before the next line stays a silence.
 */
function estimateEnd(startMs: number, text: string, nextStartMs: number | undefined): number {
  const spoken = startMs + Math.max(MIN_SEGMENT_MS, wordCount(text) * SPOKEN_MS_PER_WORD);
  return nextStartMs === undefined ? spoken : Math.min(spoken, nextStartMs);
}

export function parseJsonTranscript(content: string): TranscriptSegment[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new TranscriptFormatError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(data)) throw new TranscriptFormatError('expected a JSON array of segments');

  const segments: TranscriptSegment[] = data.map((entry, index) => {
    const where = `segment ${index}`;
    if (typeof entry !== 'object' || entry === null) throw new TranscriptFormatError(`${where}: not an object`);
    const { speaker, text, startMs, endMs } = entry as Record<string, unknown>;
    if (typeof speaker !== 'string' || speaker.trim().length === 0) {
      throw new TranscriptFormatError(`${where}: speaker must be a non-empty string`);
    }
    if (typeof text !== 'string') throw new TranscriptFormatError(`${where}: text must be a string`);
    if (!isTime(startMs)) throw new TranscriptFormatError(`${where}: startMs must be a non-negative number`);
    if (!isTime(endMs) || endMs < startMs) throw new TranscriptFormatError(`${where}: endMs must be a number >= startMs`);
    return { speaker: speaker.trim(), text, startMs, endMs };
  });
  if (segments.length === 0) throw new TranscriptFormatError('the transcript has no segments');
  return segments;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function speakersOf(segments: TranscriptSegment[]): string[] {
  return [...new Set(segments.map((segment) => segment.speaker))];
}

/**
 * Relabels one named speaker as 'me' (the engineer the engine works for);
 * everyone else keeps their name. Matching ignores case.
 */
export function assignMe(segments: TranscriptSegment[], name: string): TranscriptSegment[] {
  const wanted = name.trim().toLowerCase();
  if (!segments.some((segment) => segment.speaker.toLowerCase() === wanted)) {
    throw new TranscriptFormatError(`no speaker named "${name}" (speakers: ${speakersOf(segments).join(', ')})`);
  }
  return segments.map((segment) =>
    segment.speaker.toLowerCase() === wanted ? { ...segment, speaker: 'me' } : segment,
  );
}
