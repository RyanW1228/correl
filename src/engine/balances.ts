// src/engine/balances.ts
// Correl v0 — Polymarket-only balances (types only)

import type { Id } from "./types";

/**
 * For v0, treat "cash" as Polymarket USDC balance.
 * Amounts are in USD as a number for now (later: integer cents).
 */
export type UserBalances = {
  /** Internal user id (v0 can be a wallet address string) */
  userId: string;

  /** Cash available to pay fees / receive payouts */
  cashUsd: number;

  /** Asset holdings keyed by OutcomeAsset.id */
  assetQty: Record<Id, number>;
};
