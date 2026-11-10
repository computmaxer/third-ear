# Third Ear

A private meeting assistant for engineers. It listens to a feature discussion
and keeps a short list of what the group has not pinned down yet:

- **Ambiguities**: something said that could be read two ways.
- **Unaddressed concerns**: something nobody covered that will matter at
  implementation time.
- **Contradictions**: two statements that cannot both hold.
- **Implicit decisions**: a decision the conversation assumes but nobody stated.

It is not a "what to say next" coach. It aims to raise few gaps, each tied to a
verbatim quote from the transcript, and to retire them once the conversation
answers them. It also keeps a short running list of the big ideas so far.

It is a note-taking aid. It has no features for hiding itself from other
participants or from screen sharing, and none are planned.

## Status

Early. What exists today is the gap engine and a tool for replaying a recorded
transcript through it. There is **no live app yet**: nothing captures audio or
shows the output during a meeting. The engine has not yet been evaluated
against real meeting transcripts.

## Try it

Requires Node.js 22.12 or later.

```bash
npm install
```

Replay the sample meeting offline, with a scripted model and no API key:

```bash
npm run replay -- fixtures/gap-engine/sample-meeting.txt --me Max \
  --offline fixtures/gap-engine/sample-offline-script.json
```

Replay it with Claude, using your own Anthropic API key:

```bash
ANTHROPIC_API_KEY=... npm run replay -- fixtures/gap-engine/sample-meeting.txt --me Max
```

The replay prints a timeline and writes `replay-out/report.md` and
`replay-out/runs.json`. See [docs/gap-engine.md](docs/gap-engine.md) for the
rules and their defaults, the transcript formats, the replay options and how to
iterate on the prompt.

## Development

```bash
npm run typecheck
npm test
npm run lint
```

## Layout

```
src/core/gap-engine/   The engine: scheduling, ledger rules, prompt, Claude adapter
scripts/replay.ts      Replay command
fixtures/gap-engine/   Sample meeting, its answer key and an offline script
tests/                 Unit tests (node:test)
docs/gap-engine.md     How the engine works
```

## License

[MIT](LICENSE)
