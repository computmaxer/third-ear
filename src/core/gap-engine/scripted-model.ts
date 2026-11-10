/**
 * A deterministic GapModel that plays back prepared responses, one per run.
 * Used by tests and for offline replays that must not touch the network.
 */

import type { AnalyzeInput, AnalyzeOutput, GapModel } from './model';

export type ScriptStep =
  | AnalyzeOutput
  | ((input: AnalyzeInput, callIndex: number) => AnalyzeOutput | Promise<AnalyzeOutput>);

export const EMPTY_OUTPUT = { raise: [], resolve: [], update: [], drop: [], bigIdeas: [] };

/** Wrap raw model JSON as a successful response. */
export function scripted(output: unknown): AnalyzeOutput {
  return { ok: true, output };
}

export class ScriptedGapModel implements GapModel {
  /** Every input received, in order, for assertions and inspection. */
  readonly inputs: AnalyzeInput[] = [];

  /** Once the script runs out, every further run returns `whenExhausted`. */
  constructor(
    private readonly steps: ScriptStep[],
    private readonly whenExhausted: AnalyzeOutput = scripted(EMPTY_OUTPUT),
  ) {}

  async analyze(input: AnalyzeInput): Promise<AnalyzeOutput> {
    const callIndex = this.inputs.length;
    this.inputs.push(input);
    const step = this.steps[callIndex] ?? this.whenExhausted;
    return typeof step === 'function' ? step(input, callIndex) : step;
  }
}
