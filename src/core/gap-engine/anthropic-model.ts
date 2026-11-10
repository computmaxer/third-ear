/**
 * GapModel backed by Claude through the official Anthropic SDK.
 *
 * The system prompt, meeting context and already-analysed transcript form a
 * cached prefix; each run adds only its new lines, ledger and big ideas. The reply is constrained to the gap
 * operations schema, and every failure is returned as a typed error so one
 * bad call never interrupts a meeting.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AnalyzeInput, AnalyzeOutput, GapModel, GapModelError, TokenUsage } from './model';
import { GAP_OUTPUT_SCHEMA } from './operations';

export const DEFAULT_GAP_MODEL = 'claude-opus-5-5';

export type GapEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicGapModelOptions {
  /** Environment to read ANTHROPIC_API_KEY and GAP_ENGINE_MODEL from; callers pass process.env. */
  env: Record<string, string | undefined>;
  /**
   * Overrides GAP_ENGINE_MODEL and the default model. The request uses
   * effort, a JSON schema reply format and server-side refusal fallback, so
   * the model must accept all three (Opus 5.5 or 5, Sonnet 5.5, Fable);
   * older ids such as claude-haiku-4-5 or claude-sonnet-4-5 are rejected.
   */
  model?: string;
  /** Thinking depth; higher is slower. */
  effort?: GapEffort;
  maxTokens?: number;
  /**
   * Per-request timeout, kept below the engine's max wait: a run that takes
   * longer is not useful in a live meeting.
   */
  timeoutMs?: number;
  /**
   * SDK retries per request. Default 0: the engine retries a failed run
   * itself, with the newer transcript, which beats re-sending a stale turn.
   */
  maxRetries?: number;
  /** Inject a preconfigured client (tests, proxies). */
  client?: Anthropic;
}

const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicGapModel implements GapModel {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: GapEffort;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: AnthropicGapModelOptions) {
    this.model = options.model?.trim() || options.env.GAP_ENGINE_MODEL?.trim() || DEFAULT_GAP_MODEL;
    this.effort = options.effort ?? 'medium';
    this.maxTokens = options.maxTokens ?? 16_000;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 0;
    if (options.client) {
      this.client = options.client;
    } else {
      const apiKey = options.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      this.client = new Anthropic({ apiKey });
    }
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeOutput> {
    // The breakpoint on the last history block caches the transcript so far.
    // The next run's history extends it by whole blocks, so its prefix matches.
    const content: Anthropic.Beta.BetaTextBlockParam[] = input.history
      .filter((block) => block.length > 0)
      .map((text) => ({ type: 'text', text }));
    if (content.length > 0) content[content.length - 1].cache_control = { type: 'ephemeral' };
    content.push({ type: 'text', text: input.turn });

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          betas: [SERVER_SIDE_FALLBACK_BETA],
          // On a policy decline, let the API retry on its default fallback model.
          fallbacks: 'default',
          output_config: {
            effort: this.effort,
            format: { type: 'json_schema', schema: GAP_OUTPUT_SCHEMA },
          },
          system: [
            { type: 'text', text: input.system },
            { type: 'text', text: input.stableContext, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content }],
        },
        { timeout: this.timeoutMs, maxRetries: this.maxRetries },
      );
    } catch (error) {
      return { ok: false, error: toModelError(error) };
    }

    const usage = toUsage(response.usage);
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      return { ok: false, usage, error: { kind: 'refusal', message: `model declined (${category})` } };
    }
    if (response.stop_reason === 'max_tokens') {
      return { ok: false, usage, error: { kind: 'truncated', message: 'reply hit max_tokens' } };
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    try {
      return { ok: true, output: JSON.parse(text), usage, model: response.model };
    } catch {
      return { ok: false, usage, error: { kind: 'invalid_json', message: `unparseable reply: ${text.slice(0, 200)}` } };
    }
  }
}

function toUsage(usage: Anthropic.Beta.BetaUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
  };
}

function toModelError(error: unknown): GapModelError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'auth', message: error.message, status: error.status };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { kind: 'rate_limit', message: error.message, status: error.status };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', message: error.message };
  }
  if (error instanceof Anthropic.APIError) {
    return { kind: 'api', message: error.message, status: error.status };
  }
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
}
