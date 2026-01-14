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
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new InvalidOperationError(`qty must be > 0 (got ${qty})`);
  }
  if (fromAssetId === toAssetId) {
    throw new InvalidOperationError("fromAssetId and toAssetId must differ");
  }

  const from = state.assets[fromAssetId];
  if (!from) throw new NotFoundError(`Unknown fromAssetId: ${fromAssetId}`);

  const to = state.assets[toAssetId];
  if (!to) throw new NotFoundError(`Unknown toAssetId: ${toAssetId}`);

  if (from.classId !== to.classId) {
    throw new InvalidOperationError(
      `Swap requires same classId (from=${from.classId}, to=${to.classId})`
    );
  }
  if (from.polarity !== to.polarity) {
    throw new InvalidOperationError(
      `Swap requires same polarity (from=${from.polarity}, to=${to.polarity})`
    );
  }

  const qtyOut = qty; // v0: 1:1 shares
  const notionalUsd = qty * state.fee.notionalPerShareUsd;
  const feeUsd = (notionalUsd * state.fee.feeBps) / 10_000;

  return {
    qtyIn: qty,
    qtyOut,
    notionalUsd,
    feeUsd,
  };
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
