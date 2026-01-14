import { createEmptyState } from "./state";
import {
  addEquivalenceClass,
  addMarket,
  addAsset,
  applySwap,
  applyRedeem,
} from "./engine";
import type { UserBalances } from "./balances";

function main() {
  let state = createEmptyState({ feeBps: 50 });

  // 1) Add one canonical event class E
  state = addEquivalenceClass(state, {
    id: "E1",
    name: "Event E happens",
    venues: ["polymarket"],
    outcomeIds: [],
  });

  // 2) Add two markets A and B (same real-world event, different wording)
  state = addMarket(state, {
    venue: "polymarket",
    marketId: "A",
    question: "Market A",
  });
  state = addMarket(state, {
    venue: "polymarket",
    marketId: "B",
    question: "Market B",
  });

  // 3) Add assets:
  // A-YES is POS, A-NO is NEG
  // B-NO is POS (because B is worded as NOT(E) or equivalent negation)
  state = addAsset(state, {
    id: "A_YES",
    venue: "polymarket",
    marketId: "A",
    assetId: "pm:A:yes",
    side: "YES",
    polarity: "POS",
    classId: "E1",
    label: "A YES",
  });
  state = addAsset(state, {
    id: "A_NO",
    venue: "polymarket",
    marketId: "A",
    assetId: "pm:A:no",
    side: "NO",
    polarity: "NEG",
    classId: "E1",
    label: "A NO",
  });
  state = addAsset(state, {
    id: "B_NO",
    venue: "polymarket",
    marketId: "B",
    assetId: "pm:B:no",
    side: "NO",
    polarity: "POS",
    classId: "E1",
    label: "B NO (POS)",
  });

  // 4) User starts with B_NO (POS) and A_NO (NEG), plus some cash to pay swap fee
  let bal: UserBalances = {
    userId: "user1",
    cashUsd: 10,
    assetQty: {
      B_NO: 10,
      A_NO: 10,
    },
  };

  // 5) Swap: B_NO (POS) -> A_YES (POS)
  const s = applySwap(state, bal, "B_NO", "A_YES", 10);
  console.log("SWAP quote:", s.quote);
  console.log("SWAP delta:", s.delta);
  bal = s.nextBalances;
  console.log("After swap balances:", bal);

  // 6) Redeem: A_YES (POS) + A_NO (NEG) -> $1 - fee per pair
  const r = applyRedeem(state, bal, "A_YES", "A_NO", 10);
  console.log("REDEEM quote:", r.quote);
  console.log("REDEEM delta:", r.delta);
  bal = r.nextBalances;
  console.log("After redeem balances:", bal);
}

main();
