"use client";

import React from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useReadContract } from "wagmi";
import { polygon } from "wagmi/chains";
import { formatUnits } from "viem";
import Link from "next/link";

const CORREL_ADDRESS = "0xd55963Bd90b14a2fE151C54788e58Ee84AA1F6dC" as const;
const USDC_DECIMALS = 6;

const CorrelAbi = [
  {
    name: "lpPositions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "lp", type: "address" }],
    outputs: [
      { name: "usdcShares", type: "uint256" },
      { name: "usdcWithdrawable", type: "uint256" },
      { name: "assetIds", type: "bytes32[]" },
      { name: "tokenShares", type: "uint256[]" },
      { name: "tokenWithdrawableQty", type: "uint256[]" },
    ],
  },
] as const;

export default function HomePage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onPolygon = chainId === polygon.id;

  const { data, isLoading, error, refetch } = useReadContract({
    address: CORREL_ADDRESS,
    abi: CorrelAbi,
    functionName: "lpPositions",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) && onPolygon },
  });

  const usdcShares = data?.[0] ?? BigInt(0);
  const usdcWithdrawable = data?.[1] ?? BigInt(0);
  const assetIds = data?.[2] ?? [];
  const tokenShares = data?.[3] ?? [];
  const tokenWithdrawableQty = data?.[4] ?? [];

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
      <h1>Correl v0</h1>

      <div style={{ marginBottom: 16 }}>
        <ConnectButton />
      </div>

      <Link href="/market">
        <button>Market</button>
      </Link>

      <Link href="/equiv-classes">
        <button style={{ marginLeft: 8 }}>Equivalence Classes</button>
      </Link>

      {!isConnected && (
        <div>Connect a wallet on Polygon to view lpPositions.</div>
      )}

      {isConnected && !onPolygon && (
        <div>Connected, but not on Polygon. Please switch networks.</div>
      )}

      {isConnected && onPolygon && (
        <>
          <div style={{ marginBottom: 16 }}>
            <button onClick={() => refetch()}>Refresh</button>
          </div>

          {isLoading && <div>Loading…</div>}

          {error && <div style={{ color: "red" }}>Error: {error.message}</div>}

          {!isLoading && !error && (
            <>
              <h2>USDC Pool</h2>
              <div>USDC shares: {usdcShares.toString()}</div>
              <div>
                Withdrawable USDC:{" "}
                {formatUnits(usdcWithdrawable, USDC_DECIMALS)}
              </div>

              <h2 style={{ marginTop: 24 }}>ACTIVE Token Pools</h2>

              {assetIds.length === 0 && <div>(none)</div>}

              {assetIds.length > 0 &&
                assetIds.map((assetId, i) => (
                  <div key={`${assetId}-${i}`} style={{ marginBottom: 12 }}>
                    <div>assetId: {assetId}</div>
                    <div>
                      tokenShares: {(tokenShares[i] ?? BigInt(0)).toString()}
                    </div>
                    <div>
                      tokenWithdrawableQty:{" "}
                      {(tokenWithdrawableQty[i] ?? BigInt(0)).toString()}
                    </div>
                  </div>
                ))}
            </>
          )}
        </>
      )}
    </main>
  );
}
