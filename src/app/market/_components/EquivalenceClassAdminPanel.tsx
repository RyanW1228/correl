// src/app/market/_components/EquivalenceClassAdminPanel.tsx

"use client";

import React, { useMemo, useState } from "react";
import { useWriteContract } from "wagmi";
import { useWaitForTransactionReceipt } from "wagmi";

const CORREL_ADDRESS = "0xd55963Bd90b14a2fE151C54788e58Ee84AA1F6dC" as const;

// NOTE: Your CorrelClearinghouse.sol (as pasted) does NOT have addEquivalenceClass.
// Leaving this here since it’s in your current UI, but it will revert/call-missing.
const CorrelAdminAbi = [
  {
    name: "addEquivalenceClass",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "classId", type: "bytes32" }],
    outputs: [],
  },
] as const;

function isBytes32Hex(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

function randomBytes32(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as `0x${string}`;
}

type SelectedMarket = {
  title: string;
  slug?: string;
  conditionId?: string;
  clobTokenIds?: string[];
};

type Props = {
  selectedMarket: SelectedMarket | null;
};

export function EquivalenceClassAdminPanel({ selectedMarket }: Props) {
  // Admin UI state
  const [classIdInput, setClassIdInput] = useState<string>("");
  const [localError, setLocalError] = useState<string>("");

  // WAGMI tx state
  const {
    writeContract,
    data: txHash,
    error: writeError,
    isPending,
  } = useWriteContract();

  const {
    isLoading: isConfirming,
    isSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: Boolean(txHash) },
  });

  const canCreateClass = useMemo(() => {
    return isBytes32Hex(classIdInput.trim());
  }, [classIdInput]);

  async function onAddEquivalenceClass() {
    setLocalError("");

    const trimmed = classIdInput.trim();
    if (!isBytes32Hex(trimmed)) {
      setLocalError("classId must be 0x + 64 hex characters");
      return;
    }

    writeContract({
      address: CORREL_ADDRESS,
      abi: CorrelAdminAbi,
      functionName: "addEquivalenceClass",
      args: [trimmed],
    });
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>
        Admin: Equivalence Class
      </div>

      {/* Selected market context (this is the “wire selectedMarket into admin” part) */}
      <div style={{ padding: 12, border: "2px solid black", marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Selected Market (Will Be Added To A Class)
        </div>

        {!selectedMarket && (
          <div style={{ marginTop: 6 }}>(No market selected yet)</div>
        )}

        {selectedMarket && (
          <>
            <div style={{ fontWeight: 600 }}>{selectedMarket.title}</div>

            <div style={{ fontFamily: "monospace", marginTop: 6 }}>
              slug: {selectedMarket.slug ?? "(missing)"}
            </div>
            <div style={{ fontFamily: "monospace" }}>
              conditionId: {selectedMarket.conditionId ?? "(missing)"}
            </div>
            <div style={{ fontFamily: "monospace" }}>
              clobTokenIds:{" "}
              {selectedMarket.clobTokenIds?.join(", ") ?? "(missing)"}
            </div>

            {/* Placeholder so you stay focused on the goal */}
            <div style={{ marginTop: 10, fontStyle: "italic" }}>
              Next: we’ll wire the contract call that adds this selected market
              into an existing class (needs your contract function signature).
            </div>
          </>
        )}
      </div>

      {/* Create class (existing behavior preserved) */}
      <div style={{ marginBottom: 8 }}>
        <div>classId (bytes32):</div>
        <input
          value={classIdInput}
          onChange={(e) => setClassIdInput(e.target.value)}
          placeholder="0x + 64 hex chars"
          style={{ width: 520, maxWidth: "100%" }}
        />
      </div>

      <div style={{ marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => {
            const id = randomBytes32();
            setClassIdInput(id);
          }}
        >
          Generate random classId
        </button>
      </div>

      <button
        type="button"
        onClick={onAddEquivalenceClass}
        disabled={!canCreateClass || isPending || isConfirming}
      >
        {isPending
          ? "Submitting..."
          : isConfirming
            ? "Confirming..."
            : "Add equivalence class"}
      </button>

      {localError && <div style={{ color: "red" }}>{localError}</div>}
      {writeError && (
        <div style={{ color: "red" }}>Error: {writeError.message}</div>
      )}
      {receiptError && (
        <div style={{ color: "red" }}>Error: {receiptError.message}</div>
      )}

      {txHash && (
        <div style={{ marginTop: 8 }}>
          tx: <span style={{ fontFamily: "monospace" }}>{txHash}</span>
        </div>
      )}
      {isSuccess && <div style={{ marginTop: 8 }}>Success.</div>}
    </div>
  );
}
