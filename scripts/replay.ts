/**
 * Replays a recorded meeting transcript through the gap engine on a virtual
 * clock and writes a readable report, so prompt and rule changes can be
 * compared without holding live meetings.
 *
 *   npm run replay -- <transcript> [options]
 *
 * See docs/gap-engine.md.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  AnthropicGapModel,
  ManualClock,
  OfflineScriptError,
  TimedScriptModel,
  TranscriptFormatError,
  assignMe,
  buildRunLog,
  describeEntry,
  describeSettings,
  describeSummary,
  formatText,
  formatTime,
  parseOfflineScript,
  parseTranscript,
  renderMarkdownReport,
  resolveSettings,
  runReplay,
  type ContextBlock,
  type GapModel,
  type LedgerOptions,
  type ScheduleOptions,
} from '../src/core/gap-engine';

const USAGE = `Usage: npm run replay -- <transcript> [options]

The transcript is a JSON array of segments or text lines "[mm:ss] Speaker: text".

  --me <name>              Speaker to treat as 'me' (the engineer); others keep their names
  --brief <text>           Meeting brief
  --brief-file <path>      Read the meeting brief from a file
  --context <file>         Extra context for the prompt (repeatable)
  --model <id>             Model id (default: GAP_ENGINE_MODEL or the engine default)
  --offline <script.json>  Answer from a scripted model instead of the API (no key needed)
  --out <dir>              Where to write report.md and runs.json (default: replay-out)
  --max-open <n>           Maximum open gaps at once
  --min-new-words <n>      New words needed before a run
  --min-interval <s>       Minimum seconds between runs
  --importance-floor <n>   Lowest importance (1-5) that is shown
  --verbose                Also print transcript lines and per-run sizes, tokens and latency
  -h, --help               Show this help`;

class UsageError extends Error {}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${what} ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
}

function writeOutput(path: string, content: string): void {
  try {
    writeFileSync(path, content);
  } catch (error) {
    throw new UsageError(`cannot write ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
}

function numberOption(
  name: string,
  value: string | undefined,
  limits: { min: number; max?: number; integer?: boolean },
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const valid =
    value.trim() !== '' &&
    Number.isFinite(parsed) &&
    parsed >= limits.min &&
    (limits.max === undefined || parsed <= limits.max) &&
    (!limits.integer || Number.isInteger(parsed));
  if (!valid) {
    const range = limits.max === undefined ? `>= ${limits.min}` : `${limits.min}-${limits.max}`;
    throw new UsageError(`--${name} must be ${limits.integer ? 'an integer' : 'a number'} ${range}, got "${value}"`);
  }
  return parsed;
}

function mul(value: number | undefined, factor: number): number | undefined {
  return value === undefined ? undefined : value * factor;
}

/** Drops unset tunables so engine defaults apply. */
function defined<T extends object>(values: { [K in keyof T]?: number }): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      me: { type: 'string' },
      brief: { type: 'string' },
      'brief-file': { type: 'string' },
      context: { type: 'string', multiple: true },
      model: { type: 'string' },
      offline: { type: 'string' },
      out: { type: 'string' },
      'max-open': { type: 'string' },
      'min-new-words': { type: 'string' },
      'min-interval': { type: 'string' },
      'importance-floor': { type: 'string' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError('expected exactly one transcript file');
  if (values.brief !== undefined && values['brief-file'] !== undefined) {
    throw new UsageError('use --brief or --brief-file, not both');
  }

  const transcriptPath = positionals[0];
  let segments = parseTranscript(readText(transcriptPath, 'transcript'));
  if (values.me !== undefined) segments = assignMe(segments, values.me);

  const brief = values['brief-file'] !== undefined ? readText(values['brief-file'], 'brief') : values.brief;
  const contextBlocks: ContextBlock[] = (values.context ?? []).map((path) => ({
    label: basename(path),
    text: readText(path, 'context file'),
  }));

  const schedule = defined<ScheduleOptions>({
    minNewWords: numberOption('min-new-words', values['min-new-words'], { min: 1, integer: true }),
    minIntervalMs: mul(numberOption('min-interval', values['min-interval'], { min: 0 }), 1000),
  });
  const ledger = defined<LedgerOptions>({
    maxOpen: numberOption('max-open', values['max-open'], { min: 1, integer: true }),
    importanceFloor: numberOption('importance-floor', values['importance-floor'], { min: 1, max: 5, integer: true }),
  });

  // Created before the replay so a bad path fails fast instead of after every model call.
  const outDir = values.out ?? 'replay-out';
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (error) {
    throw new UsageError(`cannot write to ${outDir}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }

  const clock = new ManualClock(0);
  let model: GapModel;
  let modelLabel: string;
  let scriptModel: TimedScriptModel | undefined;
  if (values.offline !== undefined) {
    if (values.model !== undefined) console.error('note: --model is ignored with --offline');
    scriptModel = new TimedScriptModel(parseOfflineScript(readText(values.offline, 'offline script')), clock);
    model = scriptModel;
    modelLabel = `offline script ${values.offline}`;
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('No ANTHROPIC_API_KEY set: export it to replay against the API, or pass --offline <script.json> to use a scripted model.');
      return 1;
    }
    const anthropic = new AnthropicGapModel({ env: process.env, model: values.model });
    model = anthropic;
    modelLabel = anthropic.model;
  }

  const verbose = values.verbose ?? false;
  const header = { transcript: transcriptPath, model: modelLabel };
  const last = segments[segments.length - 1];
  console.log(`Replaying ${transcriptPath} (${segments.length} segments, ${formatTime(last.endMs)}) with ${modelLabel}`);
  console.log(`settings: ${describeSettings(resolveSettings({ schedule, ledger }))}\n`);

  const started = Date.now();
  const report = await runReplay({
    segments,
    model,
    clock,
    brief: { brief, contextBlocks },
    schedule,
    ledger,
    onEntry: (entry) => {
      const lines = describeEntry(entry, { verbose });
      if (lines.length > 0) console.log(formatText(lines));
    },
  });
  const wallMs = Date.now() - started;
  const summary = { wallMs, unusedResponses: scriptModel?.unused().length };

  console.log(`\nSummary\n${formatText(describeSummary(report, summary))}`);

  writeOutput(join(outDir, 'report.md'), renderMarkdownReport(report, header, { verbose, ...summary }));
  writeOutput(join(outDir, 'runs.json'), `${JSON.stringify(buildRunLog(report, header), null, 2)}\n`);
  console.log(`\nWrote ${join(outDir, 'report.md')} and ${join(outDir, 'runs.json')}`);

  // A replay whose model calls failed is not a baseline: say so in the exit status.
  const failed = report.runs.filter((run) => run.error).length;
  const lastRun = report.runs[report.runs.length - 1];
  if (lastRun && (failed === report.runs.length || lastRun.error)) {
    const why = failed === report.runs.length ? 'every model call failed' : 'the final run failed';
    console.error(`replay: ${why} (${failed} of ${report.runs.length} runs failed), so some speech was never analysed`);
    return 1;
  }
  if (failed > 0) console.error(`replay: ${failed} of ${report.runs.length} runs failed; later runs covered their speech`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (isUserError(error)) {
      console.error(`replay: ${error.message}`);
      if (!(error instanceof TranscriptFormatError || error instanceof OfflineScriptError)) {
        console.error('Run with --help for usage.');
      }
      process.exitCode = 2;
    } else {
      console.error(error);
      process.exitCode = 1;
    }
  },
);

/** Errors caused by the command line or input files: report the message, not a stack. */
function isUserError(error: unknown): error is Error {
  if (error instanceof UsageError || error instanceof TranscriptFormatError || error instanceof OfflineScriptError) {
    return true;
  }
  // node:util parseArgs reports unknown or malformed options with these codes.
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof Error && typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
}
