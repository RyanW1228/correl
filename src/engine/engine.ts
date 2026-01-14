// src/engine/engine.ts
// Correl v0 — Engine API (signatures only, no logic)

import type {
  EngineState,
  MarketRef,
  OutcomeAsset,
  EquivalenceClass,
  SwapQuote,
  RedeemQuote,
  Id,
} from "./types";
import type { UserBalances } from "./balances";

/** Errors (signatures only; we’ll implement later) */
export class EngineError extends Error {}
export class NotFoundError extends EngineError {}
export class InvalidOperationError extends EngineError {}
export class InsufficientBalanceError extends EngineError {}

/** --- Admin-ish registry ops (v0: overseer-controlled) --- */
export function addMarket(state: EngineState, market: MarketRef): EngineState {
  throw new Error("not implemented");
}

export function addAsset(state: EngineState, asset: OutcomeAsset): EngineState {
  throw new Error("not implemented");
}

export function addEquivalenceClass(
  state: EngineState,
  eqc: EquivalenceClass
): EngineState {
  throw new Error("not implemented");
}

/** --- Quotes (no state changes) --- */
/**
 * Quote a payoff-equivalent swap.
 * Valid iff: same classId AND same polarity.
 */
export function quoteSwap(
  state: EngineState,
  fromAssetId: Id,
  toAssetId: Id,
  qty: number
): SwapQuote {
  throw new Error("not implemented");
}

/**
 * Quote a redemption of opposite-payoff assets (POS + NEG).
 * Valid iff: same classId AND opposite polarity.
 */
export function quoteRedeem(
  state: EngineState,
  posAssetId: Id,
  negAssetId: Id,
  qtyPairs: number
): RedeemQuote {
  throw new Error("not implemented");
}

/** --- Apply (state changes to balances; engine state unchanged for v0) --- */
export type ApplySwapResult = {
  quote: SwapQuote;
  nextBalances: UserBalances;
};

/**
 * Apply a payoff-equivalent swap.
 * Valid iff: same classId AND same polarity.
 */
export function applySwap(
  state: EngineState,
  balances: UserBalances,
  fromAssetId: Id,
  toAssetId: Id,
  qty: number
): ApplySwapResult {
  throw new Error("not implemented");
}

export type ApplyRedeemResult = {
  quote: RedeemQuote;
  nextBalances: UserBalances;
};

/**
 * Apply a redemption of opposite-payoff assets (POS + NEG).
 * Valid iff: same classId AND opposite polarity.
 */
export function applyRedeem(
  state: EngineState,
  balances: UserBalances,
  posAssetId: Id,
  negAssetId: Id,
  qtyPairs: number
): ApplyRedeemResult {
  throw new Error("not implemented");
}
