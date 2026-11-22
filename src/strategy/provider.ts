import type { HandType } from "./hands";
export type Action = "fold" | "check" | "call" | "raise" | "all-in";
export interface StrategyContext {
  street: "preflop";
  playerCount: number;
  heroSeat: number;
  dealerSeat: number;
  smallBlind: number;
  bigBlind: number;
  bigBlindAnte: number;
  stacks: number[];
  actions: ReadonlyArray<{ seat: number; action: Action; total?: number }>;
}
export type StrategyResult =
  | { status: "unavailable"; reason: string }
  | {
      status: "available";
      source: string;
      assumptions: string[];
      hands: Partial<Record<HandType, Partial<Record<Action, number>>>>;
    };
/** Providers must reject unsupported scenarios; no assumed strategy is returned as solved. */
export interface StrategyProvider {
  getStrategy(context: StrategyContext): StrategyResult;
}
export const unavailableStrategy: StrategyProvider = {
  getStrategy: () => ({
    status: "unavailable",
    reason: "Для этой ситуации рассчитанная стратегия пока не загружена.",
  }),
};
