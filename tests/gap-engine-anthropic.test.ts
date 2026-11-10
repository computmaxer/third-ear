/**
 * Tests for the Anthropic-backed GapModel adapter, using a fake client so no
 * network or API key is needed.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicGapModel, DEFAULT_GAP_MODEL } from '../src/core/gap-engine/anthropic-model';
import type { AnalyzeInput } from '../src/core/gap-engine/model';
import { GAP_OUTPUT_SCHEMA } from '../src/core/gap-engine/operations';

const input: AnalyzeInput = { system: 'SYSTEM', stableContext: 'BRIEF', history: ['HEADER', 'RUN 1'], turn: 'TURN' };

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_GAP_MODEL,
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: JSON.stringify({ raise: [], resolve: [], update: [], drop: [], bigIdeas: ['x'] }) }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

type Params = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- request bodies are inspected loosely

function fakeClient(respond: (params: Params) => unknown) {
  const calls: Params[] = [];
  const requestOptions: Params[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Params, options: Params) => {
          calls.push(params);
          requestOptions.push(options);
          return respond(params);
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls, requestOptions };
}

test('requires an API key when no client is injected', () => {
  assert.throws(() => new AnthropicGapModel({ env: {} }), /ANTHROPIC_API_KEY/);
  assert.doesNotThrow(() => new AnthropicGapModel({ env: { ANTHROPIC_API_KEY: 'test-key' } }));
});

test('model comes from the option, then GAP_ENGINE_MODEL, then the default', () => {
  const { client } = fakeClient(() => message());
  assert.equal(new AnthropicGapModel({ env: {}, client }).model, DEFAULT_GAP_MODEL);
  assert.equal(new AnthropicGapModel({ env: { GAP_ENGINE_MODEL: 'env-model' }, client }).model, 'env-model');
  assert.equal(new AnthropicGapModel({ env: { GAP_ENGINE_MODEL: 'env-model' }, model: 'opt-model', client }).model, 'opt-model');
});

test('blank model settings fall back to the default', () => {
  const { client } = fakeClient(() => message());
  assert.equal(new AnthropicGapModel({ env: { GAP_ENGINE_MODEL: '' }, client }).model, DEFAULT_GAP_MODEL);
  assert.equal(new AnthropicGapModel({ env: { GAP_ENGINE_MODEL: '  ' }, model: '', client }).model, DEFAULT_GAP_MODEL);
  assert.equal(new AnthropicGapModel({ env: { GAP_ENGINE_MODEL: 'env-model' }, model: ' ', client }).model, 'env-model');
});

test('timeout and retries apply per request, also with an injected client', async () => {
  const { client, requestOptions } = fakeClient(() => message());
  await new AnthropicGapModel({ env: {}, client }).analyze(input);
  await new AnthropicGapModel({ env: {}, client, timeoutMs: 5000, maxRetries: 2 }).analyze(input);
  assert.deepEqual(requestOptions, [
    { timeout: 60_000, maxRetries: 0 },
    { timeout: 5000, maxRetries: 2 },
  ]);
});

test('the first run, with no transcript history beyond the header, still sends valid blocks', async () => {
  const { client, calls } = fakeClient(() => message());
  await new AnthropicGapModel({ env: {}, client }).analyze({ ...input, history: [] });
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: [{ type: 'text', text: 'TURN' }] }]);
});

test('sends a cacheable prefix, the output schema, and the per-run turn', async () => {
  const { client, calls } = fakeClient(() => message());
  const result = await new AnthropicGapModel({ env: {}, client }).analyze(input);

  assert.equal(result.ok, true);
  assert.ok(result.ok && Array.isArray((result.output as { bigIdeas?: unknown }).bigIdeas));
  const [params] = calls;
  assert.equal(params.model, DEFAULT_GAP_MODEL);
  assert.deepEqual(params.system, [
    { type: 'text', text: 'SYSTEM' },
    { type: 'text', text: 'BRIEF', cache_control: { type: 'ephemeral' } },
  ]);
  assert.deepEqual(params.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'HEADER' },
        { type: 'text', text: 'RUN 1', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'TURN' },
      ],
    },
  ]);
  assert.deepEqual(params.output_config, {
    effort: 'medium',
    format: { type: 'json_schema', schema: GAP_OUTPUT_SCHEMA },
  });
  assert.equal(params.temperature, undefined);
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(result.ok && result.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 80,
    cacheCreationInputTokens: 0,
  });
});

test('refusal and truncation are typed failures', async () => {
  const refused = fakeClient(() =>
    message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [] }),
  );
  const refusal = await new AnthropicGapModel({ env: {}, client: refused.client }).analyze(input);
  assert.equal(!refusal.ok && refusal.error.kind, 'refusal');

  const truncatedClient = fakeClient(() => message({ stop_reason: 'max_tokens' }));
  const truncated = await new AnthropicGapModel({ env: {}, client: truncatedClient.client }).analyze(input);
  assert.equal(!truncated.ok && truncated.error.kind, 'truncated');
});

test('unparseable text is a typed failure', async () => {
  const { client } = fakeClient(() => message({ content: [{ type: 'text', text: 'Sure! Here are some gaps' }] }));
  const result = await new AnthropicGapModel({ env: {}, client }).analyze(input);
  assert.equal(!result.ok && result.error.kind, 'invalid_json');
});

test('SDK errors map to typed failures instead of throwing', async () => {
  const cases: [unknown, string][] = [
    [new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()), 'auth'],
    [new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers()), 'rate_limit'],
    [new Anthropic.InternalServerError(500, undefined, 'boom', new Headers()), 'api'],
    [new Anthropic.APIConnectionError({ message: 'offline' }), 'network'],
    [new Error('weird'), 'unknown'],
  ];
  for (const [error, kind] of cases) {
    const { client } = fakeClient(() => {
      throw error;
    });
    const result = await new AnthropicGapModel({ env: {}, client }).analyze(input);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.kind, kind);
  }
});
