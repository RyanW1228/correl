// src/engine/types.ts
// Correl v0 — Polymarket-specific types (no logic)

export type Id = string;

/** v0 scope: Polymarket only */
export type Venue = "polymarket";

/** Venue label for an outcome */
export type Side = "YES" | "NO";

/**
 * Payoff orientation relative to the equivalence class's canonical event E.
 * POS = pays if E happens
 * NEG = pays if NOT(E) happens
 */
export type Polarity = "POS" | "NEG";

/**
 * Polymarket market = the question/container.
 * Example: "Who will win Super Bowl 2026?"
 */
export type MarketRef = {
  venue: Venue;

  /** Polymarket market id (e.g., conditionId) */
  marketId: string;

  /** Optional display fields */
  question?: string;
  slug?: string;
};

/**
 * Polymarket outcome asset = one option/position within a market.
 * Example: "Seattle wins".
 * This is the unit Correl swaps/escrows.
 */
export type OutcomeAsset = {
  /** Internal Correl id */
  id: Id;

  venue: Venue;

  /** Parent market (question) */
  marketId: string;

  /**
   * Polymarket asset id for this option (token/position id).
   * Uniquely identifies the tradable outcome.
   */
  assetId: string;

  /** Venue label (YES / NO) */
  side: Side;

  /**
   * Payoff orientation relative to the class's canonical event E.
   * Enables swaps across YES/NO when wording is negated (e.g., A-YES ≡ B-NO).
   */
  polarity: Polarity;

  /** Equivalence class (canonical real-world event) */
  classId: Id;

  /** Optional label (e.g., "Seattle") */
  label?: string;
};

/**
 * Equivalence class = a single real-world event across markets/options.
 * Members must be logically equivalent.
 */
export type EquivalenceClass = {
  id: Id;
  name: string;

  /** v0: ["polymarket"] */
  venues: Venue[];

  /** Member assets (OutcomeAsset ids) */
  outcomeIds: Id[];
};

/**
 * Fee configuration.
 * v0: proportional fee (bps) on notional.
 */
export type FeeConfig = {
  /** Basis points (50 bps = 0.50%) */
  feeBps: number;

  /** v0 assumption: 1 share ~= $1 notional */
  notionalPerShareUsd: number;
};

/** Quote for a payoff-equivalent swap (A → B), 1:1 shares in v0 */
export type SwapQuote = {
  qtyIn: number;
  qtyOut: number; // v0: 1:1
  notionalUsd: number;
  feeUsd: number;
};

/** Quote for redeeming opposite-payoff assets (POS + NEG) */
export type RedeemQuote = {
  qtyPairs: number;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
};

/** Engine state (types only, in-memory for v0) */
export type EngineState = {
  /** Markets keyed by `${venue}:${marketId}` */
  markets: Record<string, MarketRef>;

  /** Assets keyed by internal Correl id */
  assets: Record<Id, OutcomeAsset>;

  /** Equivalence classes */
  classes: Record<Id, EquivalenceClass>;

  /** Global fee config */
  fee: FeeConfig;
};
