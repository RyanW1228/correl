// src/app/market/page.tsx

"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useChainId } from "wagmi";
import { polygon } from "wagmi/chains";

import { MarketSearchPanel } from "./_components/MarketSearchPanel";
import { EquivalenceClassAdminPanel } from "./_components/EquivalenceClassAdminPanel";

// Admin wallet
const ADMIN_ADDRESS = "0x1E025245946191c40DcE3bBb3784494eD79BAe16";

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

    yesTokenId?: string; // uint256 as string
    noTokenId?: string; // uint256 as string
    clobTokenIds?: string[];
  } | null>(null);

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

      {/* ------------------------- */}
      {/* Existing Admin UI */}
      {/* ------------------------- */}
      {isAdmin && (
        <EquivalenceClassAdminPanel selectedMarket={selectedMarket} />
      )}

      {!isAdmin && isConnected && onPolygon && (
        <div style={{ marginBottom: 24 }}>(Connected as non-admin)</div>
      )}
    </main>
  );
}
