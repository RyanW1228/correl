// src/app/market/page.tsx

"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useChainId, useWriteContract } from "wagmi";
import { useWaitForTransactionReceipt } from "wagmi";
import { polygon } from "wagmi/chains";

import { MarketSearchPanel } from "./_components/MarketSearchPanel";
const CORREL_ADDRESS = "0xd55963Bd90b14a2fE151C54788e58Ee84AA1F6dC" as const;

// Admin wallet
const ADMIN_ADDRESS = "0x1E025245946191c40DcE3bBb3784494eD79BAe16";

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

export default function MarketPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onPolygon = chainId === polygon.id;

  const isAdmin = useMemo(() => {
    if (!isConnected || !onPolygon || !address) return false;
    return address.toLowerCase() === ADMIN_ADDRESS.toLowerCase();
  }, [address, isConnected, onPolygon]);

  // -------------------------
  // Selected Market (from MarketSearchPanel)
  // -------------------------
  const [selectedMarket, setSelectedMarket] = useState<{
    title: string;
    slug?: string;
    conditionId?: string;
    clobTokenIds?: string[];
  } | null>(null);

  // -------------------------
  // Existing Admin section
  // -------------------------
  const [classIdInput, setClassIdInput] = useState<string>("");
  const [localError, setLocalError] = useState<string>("");

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
    <main
      style={{
        background: "white",
        color: "black",
        minHeight: "100vh",
        padding: 32,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <Link href="/">Home</Link>
      </div>

      <h1>Market</h1>

      {!isConnected && <div style={{ marginBottom: 16 }}>Connect wallet.</div>}
      {isConnected && !onPolygon && (
        <div style={{ marginBottom: 16 }}>Switch to Polygon.</div>
      )}

      {/* ------------------------- */}
      {/* Market Search */}
      {/* ------------------------- */}
      <MarketSearchPanel onSelectMarket={setSelectedMarket} />

      {selectedMarket && (
        <div style={{ marginTop: 12, padding: 12, border: "2px solid black" }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            Selected Market (For Equivalence Class)
          </div>

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
        </div>
      )}

      {/* ------------------------- */}
      {/* Existing Admin UI */}
      {/* ------------------------- */}
      {isAdmin && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            Admin: Add equivalence class
          </div>

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
              onClick={() => {
                const id = randomBytes32();
                setClassIdInput(id);
              }}
            >
              Generate random classId
            </button>
          </div>

          <button
            onClick={onAddEquivalenceClass}
            disabled={isPending || isConfirming}
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
      )}

      {!isAdmin && isConnected && onPolygon && (
        <div style={{ marginBottom: 24 }}>(Connected as non-admin)</div>
      )}
    </main>
  );
}
