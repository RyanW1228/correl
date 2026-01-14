// src/engine/engine.ts
// Correl v0 — Engine API (logic)
// On-chain-friendly: apply* returns an explicit delta describing debits/credits.

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

/** Errors */
export class EngineError extends Error {}
export class NotFoundError extends EngineError {}
export class InvalidOperationError extends EngineError {}
export class InsufficientBalanceError extends EngineError {}

/** On-chain-friendly “what changes” representation */
export type BalanceDelta = {
  /** Negative = user pays (fee). Positive = user receives (payout). */
  cashUsdDelta: number;
  /** Per-asset qty deltas. Negative = debit, positive = credit. */
  assetQtyDelta: Record<Id, number>;
};

function marketKey(m: MarketRef): string {
  return `${m.venue}:${m.marketId}`;
}

function requireFinitePositive(n: number, label: string) {
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidOperationError(`${label} must be > 0 (got ${n})`);
  }
}

function getAssetOrThrow(state: EngineState, id: Id): OutcomeAsset {
  const a = state.assets[id];
  if (!a) throw new NotFoundError(`Unknown assetId: ${id}`);
  return a;
}

function getQty(bal: UserBalances, id: Id): number {
  return bal.assetQty[id] ?? 0;
}

function feeOnNotional(notionalUsd: number, feeBps: number): number {
  return (notionalUsd * feeBps) / 10_000;
}

function addDeltaAsset(d: Record<Id, number>, id: Id, delta: number) {
  if (delta === 0) return;
  d[id] = (d[id] ?? 0) + delta;
}

/** --- Admin-ish registry ops (v0: overseer-controlled) --- */
export function addMarket(state: EngineState, market: MarketRef): EngineState {
  if (!market?.venue || !market?.marketId) {
    throw new InvalidOperationError(
      "market.venue and market.marketId are required"
    );
  }

  const key = marketKey(market);
  if (state.markets[key]) {
    throw new InvalidOperationError(`Market already exists: ${key}`);
  }

  return {
    ...state,
    markets: {
      ...state.markets,
      [key]: market,
    },
  };
}

export function addEquivalenceClass(
  state: EngineState,
  eqc: EquivalenceClass
): EngineState {
  if (!eqc?.id) throw new InvalidOperationError("eqc.id is required");
  if (!eqc?.name) throw new InvalidOperationError("eqc.name is required");

  if (state.classes[eqc.id]) {
    throw new InvalidOperationError(
      `Equivalence class already exists: ${eqc.id}`
    );
  }

  // v0 sanity: only polymarket is expected, but don’t over-enforce if you want flexibility.
  if (!Array.isArray(eqc.venues) || eqc.venues.length === 0) {
    throw new InvalidOperationError("eqc.venues must be a non-empty array");
  }
  if (!Array.isArray(eqc.outcomeIds)) {
    throw new InvalidOperationError("eqc.outcomeIds must be an array");
  }

  return {
    ...state,
    classes: {
      ...state.classes,
      [eqc.id]: eqc,
    },
  };
}

export function addAsset(state: EngineState, asset: OutcomeAsset): EngineState {
  if (!asset?.id) throw new InvalidOperationError("asset.id is required");
  if (!asset?.venue) throw new InvalidOperationError("asset.venue is required");
  if (!asset?.marketId)
    throw new InvalidOperationError("asset.marketId is required");
  if (!asset?.assetId)
    throw new InvalidOperationError("asset.assetId is required");
  if (!asset?.classId)
    throw new InvalidOperationError("asset.classId is required");

  if (state.assets[asset.id]) {
    throw new InvalidOperationError(`Asset already exists: ${asset.id}`);
  }

  // Optional but helpful: ensure the class exists (since your swap/redeem depend on it).
  if (!state.classes[asset.classId]) {
    throw new NotFoundError(`Unknown classId on asset: ${asset.classId}`);
  }

  // Optional: ensure the market exists by key (if you’re using markets registry)
  const mk = `${asset.venue}:${asset.marketId}`;
  if (Object.keys(state.markets).length > 0 && !state.markets[mk]) {
    // only enforce if markets are being used; you can remove this if annoying
    throw new NotFoundError(`Unknown market key for asset: ${mk}`);
  }

  const nextAssets = { ...state.assets, [asset.id]: asset };

  // Keep class membership list in sync (nice for audits / UI)
  const cls = state.classes[asset.classId];
  const already = cls.outcomeIds.includes(asset.id);
  const nextClass: EquivalenceClass = already
    ? cls
    : { ...cls, outcomeIds: [...cls.outcomeIds, asset.id] };

  return {
    ...state,
    assets: nextAssets,
    classes: {
      ...state.classes,
      [asset.classId]: nextClass,
    },
  };
}

/** --- Quotes (no state changes) --- */
/**
 * Quote a payoff-equivalent swap.
 * Valid iff: same classId AND same polarity.
 * v0 fee: notional-based (bps * qty * notionalPerShareUsd).
 */
export function quoteSwap(
  state: EngineState,
  fromAssetId: Id,
  toAssetId: Id,
  qty: number
): SwapQuote {
  requireFinitePositive(qty, "qty");

  if (fromAssetId === toAssetId) {
    throw new InvalidOperationError("fromAssetId and toAssetId must differ");
  }

  const from = getAssetOrThrow(state, fromAssetId);
  const to = getAssetOrThrow(state, toAssetId);

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

  const qtyOut = qty; // v0: 1:1
  const notionalUsd = qty * state.fee.notionalPerShareUsd;
  const feeUsd = feeOnNotional(notionalUsd, state.fee.feeBps);

  return { qtyIn: qty, qtyOut, notionalUsd, feeUsd };
}

/**
 * Quote a redemption of opposite-payoff assets (POS + NEG).
 * Valid iff: same classId AND opposite polarity (POS, NEG).
 */
export function quoteRedeem(
  state: EngineState,
  posAssetId: Id,
  negAssetId: Id,
  qtyPairs: number
): RedeemQuote {
  requireFinitePositive(qtyPairs, "qtyPairs");

  if (posAssetId === negAssetId) {
    throw new InvalidOperationError("posAssetId and negAssetId must differ");
  }

  const pos = getAssetOrThrow(state, posAssetId);
  const neg = getAssetOrThrow(state, negAssetId);

  if (pos.classId !== neg.classId) {
    throw new InvalidOperationError(
      `Redeem requires same classId (pos=${pos.classId}, neg=${neg.classId})`
    );
  }
  if (pos.polarity !== "POS") {
    throw new InvalidOperationError(
      `posAssetId must have polarity POS (got ${pos.polarity})`
    );
  }
  if (neg.polarity !== "NEG") {
    throw new InvalidOperationError(
      `negAssetId must have polarity NEG (got ${neg.polarity})`
    );
  }

  const grossUsd = qtyPairs * state.fee.notionalPerShareUsd;
  const feeUsd = feeOnNotional(grossUsd, state.fee.feeBps);
  const netUsd = grossUsd - feeUsd;

  if (netUsd < 0) {
    throw new InvalidOperationError("fee exceeds gross (check fee config)");
  }

  return { qtyPairs, grossUsd, feeUsd, netUsd };
}

/** --- Apply (state changes to balances; engine state unchanged for v0) --- */
export type ApplySwapResult = {
  quote: SwapQuote;
  nextBalances: UserBalances;
  delta: BalanceDelta;
};

/**
 * Apply a payoff-equivalent swap.
 * Valid iff: same classId AND same polarity.
 * Requires user has qty of fromAsset and enough cashUsd to pay fee.
 */
export function applySwap(
  state: EngineState,
  balances: UserBalances,
  fromAssetId: Id,
  toAssetId: Id,
  qty: number
): ApplySwapResult {
  const quote = quoteSwap(state, fromAssetId, toAssetId, qty);

  const fromHave = getQty(balances, fromAssetId);
  if (fromHave < qty) {
    throw new InsufficientBalanceError(
      `Insufficient ${fromAssetId}: need ${qty}, have ${fromHave}`
    );
  }
  if (balances.cashUsd < quote.feeUsd) {
    throw new InsufficientBalanceError(
      `Insufficient cashUsd for swap fee: need ${quote.feeUsd}, have ${balances.cashUsd}`
    );
  }

  const delta: BalanceDelta = {
    cashUsdDelta: -quote.feeUsd,
    assetQtyDelta: {},
  };
  addDeltaAsset(delta.assetQtyDelta, fromAssetId, -qty);
  addDeltaAsset(delta.assetQtyDelta, toAssetId, +qty);

  const nextBalances: UserBalances = {
    ...balances,
    cashUsd: balances.cashUsd + delta.cashUsdDelta,
    assetQty: { ...balances.assetQty },
  };

  nextBalances.assetQty[fromAssetId] = fromHave - qty;
  nextBalances.assetQty[toAssetId] = getQty(nextBalances, toAssetId) + qty;

  return { quote, nextBalances, delta };
}

export type ApplyRedeemResult = {
  quote: RedeemQuote;
  nextBalances: UserBalances;
  delta: BalanceDelta;
};

/**
 * Apply a redemption of opposite-payoff assets (POS + NEG).
 * Requires user has qtyPairs of both assets.
 * Credits netUsd to cashUsd.
 */
export function applyRedeem(
  state: EngineState,
  balances: UserBalances,
  posAssetId: Id,
  negAssetId: Id,
  qtyPairs: number
): ApplyRedeemResult {
  const quote = quoteRedeem(state, posAssetId, negAssetId, qtyPairs);

  const posHave = getQty(balances, posAssetId);
  const negHave = getQty(balances, negAssetId);

  if (posHave < qtyPairs) {
    throw new InsufficientBalanceError(
      `Insufficient ${posAssetId}: need ${qtyPairs}, have ${posHave}`
    );
  }
  if (negHave < qtyPairs) {
    throw new InsufficientBalanceError(
      `Insufficient ${negAssetId}: need ${qtyPairs}, have ${negHave}`
    );
  }

  const delta: BalanceDelta = {
    // Redeem pays net to user (fee is embedded as gross-net)
    cashUsdDelta: +quote.netUsd,
    assetQtyDelta: {},
  };
  addDeltaAsset(delta.assetQtyDelta, posAssetId, -qtyPairs);
  addDeltaAsset(delta.assetQtyDelta, negAssetId, -qtyPairs);

  const nextBalances: UserBalances = {
    ...balances,
    cashUsd: balances.cashUsd + delta.cashUsdDelta,
    assetQty: { ...balances.assetQty },
  };

  nextBalances.assetQty[posAssetId] = posHave - qtyPairs;
  nextBalances.assetQty[negAssetId] = negHave - qtyPairs;

  return { quote, nextBalances, delta };
}
