# Gap engine

The gap engine is a meeting assistant for an engineer. A subject matter
expert and a product manager describe a feature, and the engine listens and
keeps a short list of **gaps**: things the group has not pinned down yet.
It is not a "what to say next" coach. It aims to raise few gaps, each
specific to what was said, and to retire them once the conversation answers
them.

**Status:** the engine is a self-contained TypeScript module in
`src/core/gap-engine/`, with tests and an offline replay tool. There is **no
live app yet**: nothing captures audio or shows the output during a meeting.

## What it does

The four kinds of gap:

| Kind | Meaning |
|------|---------|
| `ambiguity` | Something said that is unclear or could be read two ways that lead to different implementations |
| `unaddressed` | Something nobody has covered that will matter when building what was described |
| `contradiction` | Two statements, by the same or different speakers, that cannot both hold |
| `implicit_decision` | A decision the conversation now assumes but nobody stated |

Transcript segments arrive with a free-form speaker label: `me` for the
user's microphone, and `them` or real names for everyone else. Each segment
also carries start and end times. The engine decides when an analysis run is
worth making. On each run it sends the model the system prompt, the meeting
brief, the whole transcript so far, the current list of big ideas, the ledger
of gaps so far, and any raises the rules held back on the previous run. The
transcript is split into lines already analysed and lines new since the last
run; the model may raise from either, so a contradiction with something said
twenty minutes ago can quote both sides.

The model replies with operations: `raise`, `resolve`, `update` and `drop`,
plus a full replacement list of big ideas. Plain code in `ledger.ts`, not the
prompt, decides which operations take effect. Every change emits an event
with a snapshot of the open gaps, resolved gaps, gaps retired unanswered
(stale or displaced) and big ideas.

## Rules and defaults

Scheduling (`engine.ts`, `DEFAULT_SCHEDULE`):

| Rule | Default |
|------|---------|
| Run once enough new words have arrived and enough time has passed since the last run | 60 words and 25s |
| Run anyway once the oldest unanalysed speech is this old | 75s |
| Concurrent runs | never; speech that arrives during a run goes to the next run, and a second `flush()` waits for the first |
| After a failed run | its speech stays unanalysed; the retry waits the larger of 10s (`retryDelayMs`) and the min interval, doubling with each further failure up to 5 min |
| `flush()` | forces a final run over any leftover speech |

Ledger (`ledger.ts`, `DEFAULT_LEDGER_OPTIONS`):

| Rule | Default | Rejection reason |
|------|---------|------------------|
| A raise needs at least one evidence quote found in the transcript (quotes not found are dropped); a resolve's quote must be found | at least 3 words, 2 of them not filler; 80% of the words, and 80% of the meaningful words, within a nearby span | `evidence_not_found` |
| A resolve must not quote the gap's own raising evidence | 80% of its words inside that quote, same segment | `not_an_answer` |
| Minimum importance (1-5) of a raise | 3 | `below_importance_floor` |
| Open gaps at once; a new raise gets in only by out-ranking the weakest open gap, which expires as `displaced` | 3 | `over_budget` |
| Raises accepted per run, most important first | 1 | `max_raises_per_run` |
| Near-duplicate questions are rejected against gaps of every status, dismissed ones included, for raises and for updates that reword a question | word-overlap similarity 0.5 | `duplicate` |
| A raise quoting the same statements as an existing gap of the same kind is a duplicate, however it is worded | same segment, 60% of the meaningful words | `duplicate` |
| A raise near a gap retired unanswered (stale or displaced) reopens that gap instead, if it quotes new speech | as above | none |
| Time between accepted raises, unless importance is 5 | 60s | `cooldown` |
| Open gaps nobody touched for this long expire as `stale` | 12 min | none |
| Operations on unknown or closed gaps, and updates that change nothing | none | `unknown_id`, `not_open`, `empty_update` |
| Output the parser cannot use | none | `malformed` |

Resolves, drops and updates are applied before raises, so a resolve can free
room for a raise in the same run. Raises stopped by `cooldown`, `over_budget`
or `max_raises_per_run` are listed for the model on the next run, so a sharp
gap is delayed rather than lost. An empty `bigIdeas` list never replaces a
non-empty one. Stored evidence uses the transcript's own words, speaker and
time, not what the model claimed.

Transcript (`prompt.ts`, `DEFAULT_TRANSCRIPT_OPTIONS`): the whole meeting.
New lines are capped at 12,000 characters per run (the oldest are cut
first). Already-analysed lines are capped at 240,000 characters, several
hours of speech; past that the oldest are dropped in steps of half the cap.
The analysed lines go into one block per run, so each run's prompt starts
with the previous run's and the provider can cache it.

Model (`anthropic-model.ts`): the Claude adapter reads `ANTHROPIC_API_KEY`.
`GAP_ENGINE_MODEL` (or the `model` option) overrides the default model, which
is `DEFAULT_GAP_MODEL`; a blank value means the default. The request uses
effort, a reply schema the API enforces and server-side refusal fallback, so
an override must be a model that accepts all three (Opus 5.5 or 5, Sonnet
5.5, Fable); older ids such as `claude-haiku-4-5` or `claude-sonnet-4-5` are
rejected by the API. The adapter uses effort `medium`, a 60s timeout and no
SDK retries (the engine retries with the newer transcript instead), and
caches the system prompt, meeting context and analysed transcript. Other
providers can implement the `GapModel` interface in `model.ts`.

## Running a replay

A replay feeds a recorded transcript through the same engine code on a
virtual clock. Each segment arrives at its end time, the clock steps through
silences one second at a time, and every model call is awaited. The timeline
therefore does not depend on how long the model takes.

```bash
# Scripted model, no network or key needed
npm run replay -- fixtures/gap-engine/sample-meeting.txt --me Max \
  --offline fixtures/gap-engine/sample-offline-script.json

# Against the API
export ANTHROPIC_API_KEY=...
npm run replay -- fixtures/gap-engine/sample-meeting.txt --me Max \
  --brief "Waitlist auto-fill for cancelled vet appointments" --out replay-out/baseline
```

Without `ANTHROPIC_API_KEY` and without `--offline`, the command exits with a
one-line message. When every model call failed, or the final run failed, the
report is still written but the command exits with status 1. A replay against the API makes one model call per run;
about 30 runs for the sample meeting.

**Transcript formats.** Either a JSON array of
`{ "speaker", "text", "startMs", "endMs" }`, or text lines like
`[mm:ss] Speaker: text` (`[hh:mm:ss]` also works). In the text form, `#`
lines are comments, blank lines are ignored, and a line without a timestamp
continues the previous line. Text lines only carry a start time. A line is
taken to end at the next line's start, or after about 400ms per word,
whichever is sooner.

| Option | Meaning |
|--------|---------|
| `--me <name>` | This speaker becomes `me`; other speakers keep their names |
| `--brief <text>`, `--brief-file <path>` | Meeting brief from the engineer |
| `--context <file>` | Extra context block (repeatable); labelled with the file name |
| `--model <id>` | Model id for the API |
| `--offline <script.json>` | Use a scripted model instead of the API |
| `--out <dir>` | Output directory (default `replay-out/`, which is gitignored) |
| `--max-open <n>`, `--min-new-words <n>`, `--min-interval <seconds>`, `--importance-floor <n>` | Engine tunables |
| `--verbose` | Also print the transcript lines, plus each run's transcript range, prompt size, tokens and latency |

**Offline scripts** are JSON:
`{ "responses": [{ "at": "mm:ss", "output": { ... } }] }`. `output` is exactly
what a model would return. Each response is used by the first run that
starts at or after `at`; runs with no response due change nothing. Keys
other than `at` and `output` are ignored, so a `note` can explain each step.
The summary counts responses that no run reached.

## Reading the report

The command prints a timeline and a summary, and writes two files:

- `<out>/report.md`: the same timeline and summary as markdown.
- `<out>/runs.json`: the full run log. It holds the settings, the system
  prompt and meeting context, the last run's transcript `history` blocks,
  and for each run the trigger, times, transcript range, prompt sizes, how
  many history blocks it was sent (`historyBlocks`), the per-run prompt
  (`turn`), the model's raw output, the accepted and rejected operations,
  tokens and latency. The final ledger comes last.

Each timeline entry starts with the meeting time it happened at:

```
[04:18] run 6 (new_words, 64 new words)
    RAISED g1 ambiguity (importance 4): Does 'close by' mean clients waitlisted at that clinic, or ...?
        why: decides whether matching needs client locations
        evidence [03:22] Dana: "we'd only offer it to people who are close by"
[05:10] run 7 (new_words, 93 new words): nothing raised
    REJECTED [evidence_not_found] raise: Do all clinics share one waitlist, or does each clinic keep its own?
        quote not in transcript: "all twelve clinics share a single waitlist"
```

- `run N (trigger, words)`: the trigger is `new_words`, `max_wait` or
  `flush`. `nothing raised` means no raise was accepted; anything else the
  run did is still listed under it.
- `RAISED`, `REOPENED` (a gap retired unanswered, raised again from new
  speech), `RESOLVED` (with how and the answering quote), `UPDATED` and
  `DROPPED` are accepted operations. `pushed out` marks a gap displaced to
  stay within budget.
- `REJECTED [reason]` is an operation a rule stopped. The reasons are in the
  table above.
- `EXPIRED ... (untouched too long)` is the staleness rule.
- `BIG IDEAS changed` lists ideas added (`+`) and removed (`-`).
- `FAILED (kind)` is a model error: auth, rate_limit, network, api, refusal,
  truncated, invalid_json or unknown.

The summary gives the number of runs, raises accepted and rejected by
reason, gaps resolved, the gaps still open at the end, the gaps retired
unanswered (stale or displaced, so still worth asking after the meeting),
the final big ideas, total input tokens with the uncached and cached parts,
output tokens, and the wall time (and how much of it was spent waiting on the
model).

## Iterating on the prompt

The prompt wording lives in `src/core/gap-engine/prompt.ts`:
`GAP_SYSTEM_PROMPT` and the builders for the meeting context and the per-run
turn. To try a change:

1. Run a baseline: `npm run replay -- <transcript> --me <you> --out replay-out/before`.
2. Edit `prompt.ts`.
3. Run again with `--out replay-out/after`.
4. Compare `replay-out/before/report.md` with `replay-out/after/report.md`,
   and check both against the answer key. For the sample meeting, the answer
   key is `fixtures/gap-engine/sample-meeting.expected.md`. Look at precision
   first: count raises that a senior engineer would not have interrupted the
   meeting for.
5. To see why the model did something, diff the `turn` and `rawOutput` of the
   matching run in the two `runs.json` files.

Things to keep in mind:

- Model output varies between calls, so one replay of each version proves
  little. Run each version more than once before you trust a difference.
- Each run's prompt includes the ledger and the big ideas, so once two
  replays differ, every later prompt differs as well.
- A rule change belongs in `ledger.ts` or `engine.ts`, not the prompt. Rules
  can be tested deterministically with the offline script (`npm test` runs
  an offline replay of the sample meeting).

## Known limitations

- The engine has not been run against the live API from this repository's
  development sandbox. The prompt, the evidence threshold (0.8) and the
  duplicate threshold (0.5) are reasoned defaults that need tuning on real
  meetings and real speech-recognition output.
- An `unaddressed` gap is, by nature, a topic nobody brings up again. So
  unless the model updates it, the 12-minute staleness rule tends to retire
  it from the live list. It stays in the snapshot's `unanswered` list and the
  replay summary. The sample offline replay shows this happening to the
  slot-length gap.
- The evidence-based duplicate guard compares quotes from the same segment.
  A re-raise that quotes a different sentence about the same topic, in
  different words, still relies on the prompt and the question-similarity
  guard.
