// src/engine/state.ts
// Correl v0 — Polymarket-only state initialization (no logic)

import type { EngineState, FeeConfig } from "./types";

export const DEFAULT_FEE_BPS = 50;
export const DEFAULT_NOTIONAL_PER_SHARE_USD = 1;

export const DEFAULT_FEE: FeeConfig = {
  feeBps: DEFAULT_FEE_BPS,
  notionalPerShareUsd: DEFAULT_NOTIONAL_PER_SHARE_USD,
};

/**
 * Create a fresh in-memory engine state.
 * v0: Polymarket-only.
 */
export function createEmptyState(opts?: { feeBps?: number }): EngineState {
  const feeBps = opts?.feeBps ?? DEFAULT_FEE_BPS;

  return {
    markets: {},
    assets: {},
    classes: {},
    fee: {
      feeBps,
      notionalPerShareUsd: DEFAULT_NOTIONAL_PER_SHARE_USD,
    },
  };
}
