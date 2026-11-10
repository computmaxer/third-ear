/**
 * Provider-neutral seam between the engine and a language model. The engine
 * builds an AnalyzeInput and receives untrusted JSON back; it never imports
 * a provider SDK.
 */

export interface AnalyzeInput {
  /** Fixed instructions; identical on every run so providers can cache it. */
  system: string;
  /** Meeting brief and context blocks; fixed for the whole meeting. */
  stableContext: string;
  /**
   * The already-analysed transcript as append-only blocks. Each run's blocks
   * start with the previous run's, byte for byte, so providers can cache
   * them; the turn continues where the last block ends.
   */
  history: string[];
  /** Per-run content: new transcript lines, big ideas, ledger. */
  turn: string;
}

export interface TokenUsage {
  /** Uncached input only; cached tokens are counted in the two cache fields. */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type GapModelErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'api'
  | 'refusal'
  | 'truncated'
  | 'invalid_json'
  | 'unknown';

export interface GapModelError {
  kind: GapModelErrorKind;
  message: string;
  status?: number;
}

export type AnalyzeOutput =
  | { ok: true; output: unknown; usage?: TokenUsage; model?: string }
  | { ok: false; error: GapModelError; usage?: TokenUsage };

export interface GapModel {
  analyze(input: AnalyzeInput): Promise<AnalyzeOutput>;
}
