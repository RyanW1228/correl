// src/app/market/page.tsx

"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useChainId, useWriteContract } from "wagmi";
import { useWaitForTransactionReceipt } from "wagmi";
import { polygon } from "wagmi/chains";

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

// --------- Search API result types (from /api/polymarket/search) ----------
type MarketResult = {
  kind: "market";
  marketId: string;
  title: string;
  slug?: string;
  conditionId?: string;
  clobTokenIds?: string[];
  url?: string;
};

type EventResult = {
  kind: "event";
  eventId: string;
  title: string;
  slug?: string;
  url?: string;
  marketsCount: number;
  markets: Array<{
    marketId: string;
    title: string;
    slug?: string;
    conditionId?: string;
    clobTokenIds?: string[];
    url?: string;
  }>;
  bestMarket?: {
    marketId: string;
    title: string;
    slug?: string;
    conditionId?: string;
    clobTokenIds?: string[];
    url?: string;
  };
};

type SearchResult = MarketResult | EventResult;

export default function MarketPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onPolygon = chainId === polygon.id;

  const isAdmin = useMemo(() => {
    if (!isConnected || !onPolygon || !address) return false;
    return address.toLowerCase() === ADMIN_ADDRESS.toLowerCase();
  }, [address, isConnected, onPolygon]);

  // -------------------------
  // Market Search (Gamma)
  // -------------------------
  const [q, setQ] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string>("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [activeEventIdx, setActiveEventIdx] = useState<number>(0);

  // Optional: fetch full market details by slug (so you can grab conditionId/token ids reliably)
  // Gamma supports fetching market details by slug. :contentReference[oaicite:3]{index=3}
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [marketDetailJson, setMarketDetailJson] = useState<string>("");

  async function onSearch() {
    const query = q.trim();
    if (!query) return;

    setSearchError("");
    setSearchLoading(true);
    setSearchResults([]);

    try {
      const url = `/api/polymarket/search?q=${encodeURIComponent(
        query,
      )}&limit=10`;

      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Search API failed (${res.status})`);

      const data = (await res.json()) as { results?: SearchResult[] };
      const next = Array.isArray(data.results) ? data.results : [];
      setSearchResults(next);
      setActiveEventIdx(0);
    } catch (e: any) {
      setSearchError(e?.message ?? "Search failed");
    } finally {
      setSearchLoading(false);
    }
  }

  async function onLoadMarketDetail(slug: string) {
    setSelectedSlug(slug);
    setMarketDetailJson("");
    setSearchError("");

    try {
      const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(
        slug,
      )}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Gamma market fetch failed (${res.status})`);
      const data = await res.json();
      setMarketDetailJson(JSON.stringify(data, null, 2));
    } catch (e: any) {
      setSearchError(e?.message ?? "Market fetch failed");
    }
  }

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
      <div style={{ marginTop: 16, marginBottom: 24 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Search Polymarket (via /api/polymarket/search)
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. patriots afc championship"
            style={{ width: 520, maxWidth: "100%" }}
          />
          <button onClick={onSearch} disabled={searchLoading}>
            {searchLoading ? "Searching..." : "Search"}
          </button>
        </div>

        {searchError && <div style={{ color: "red" }}>{searchError}</div>}

        {searchResults.length === 0 && !searchLoading && (
          <div style={{ marginTop: 8 }}>(no results yet)</div>
        )}

        {searchResults.length > 0 &&
          (() => {
            const eventResults = searchResults.filter(
              (r): r is EventResult => r.kind === "event",
            );

            if (eventResults.length === 0) {
              return <div style={{ marginTop: 8 }}>(no event results)</div>;
            }

            const safeIdx = Math.min(
              Math.max(activeEventIdx, 0),
              eventResults.length - 1,
            );
            const ev = eventResults[safeIdx];

            return (
              <div style={{ marginTop: 12 }}>
                {/* Arrow navigation */}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={() => setActiveEventIdx((i) => Math.max(0, i - 1))}
                    disabled={safeIdx === 0}
                  >
                    ←
                  </button>

                  <div style={{ fontWeight: 700 }}>
                    Event {safeIdx + 1} / {eventResults.length}
                  </div>

                  <button
                    onClick={() =>
                      setActiveEventIdx((i) =>
                        Math.min(eventResults.length - 1, i + 1),
                      )
                    }
                    disabled={safeIdx === eventResults.length - 1}
                  >
                    →
                  </button>
                </div>

                {/* Single event display */}
                <div
                  style={{
                    borderTop: "1px solid black",
                    paddingTop: 12,
                    marginTop: 12,
                  }}
                >
                  <div style={{ fontWeight: 700 }}>Event: {ev.title}</div>

                  {ev.url && (
                    <div style={{ marginTop: 6 }}>
                      <a href={ev.url} target="_blank" rel="noreferrer">
                        Open on Polymarket
                      </a>
                    </div>
                  )}

                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontFamily: "monospace" }}>
                      eventId: {ev.eventId}
                    </div>
                    <div style={{ fontFamily: "monospace" }}>
                      eventSlug: {ev.slug ?? "(missing)"}
                    </div>
                    <div>marketsCount: {ev.marketsCount}</div>

                    {/* Markets list */}
                    {Array.isArray(ev.markets) && ev.markets.length > 0 && (
                      <div style={{ marginTop: 10, paddingLeft: 12 }}>
                        <div style={{ fontWeight: 600 }}>markets</div>
                        {ev.markets.map((m, j) => (
                          <div
                            key={`ev-${ev.eventId}-m-${m.marketId}-${j}`}
                            style={{
                              borderTop: "1px dashed #999",
                              marginTop: 8,
                              paddingTop: 8,
                            }}
                          >
                            <div>{m.title}</div>
                            <div style={{ fontFamily: "monospace" }}>
                              marketId: {m.marketId}
                            </div>
                            <div style={{ fontFamily: "monospace" }}>
                              slug: {m.slug ?? "(missing)"}
                            </div>
                            <div style={{ fontFamily: "monospace" }}>
                              conditionId: {m.conditionId ?? "(missing)"}
                            </div>
                            <div style={{ fontFamily: "monospace" }}>
                              clobTokenIds:{" "}
                              {m.clobTokenIds?.join(", ") ?? "(missing)"}
                            </div>

                            {m.slug && (
                              <div
                                style={{
                                  marginTop: 8,
                                  display: "flex",
                                  gap: 8,
                                }}
                              >
                                <button
                                  onClick={() => onLoadMarketDetail(m.slug!)}
                                >
                                  Load full market JSON
                                </button>
                                <a
                                  href={`https://polymarket.com/market/${m.slug}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open market
                                </a>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {(!ev.markets || ev.markets.length === 0) && (
                      <div style={{ marginTop: 10 }}>
                        (no markets in this event)
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

        {selectedSlug && marketDetailJson && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              Market JSON for:{" "}
              <span style={{ fontFamily: "monospace" }}>{selectedSlug}</span>
            </div>
            <pre
              style={{
                background: "#f5f5f5",
                padding: 12,
                overflowX: "auto",
                maxHeight: 360,
              }}
            >
              {marketDetailJson}
            </pre>
          </div>
        )}
      </div>

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
