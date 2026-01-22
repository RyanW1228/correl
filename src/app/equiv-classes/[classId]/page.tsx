// src/app/equiv-classes/[classId]/page.tsx

"use client";

import React, { useEffect, useMemo, useState, use } from "react";
import Link from "next/link";
import { useAccount, useChainId } from "wagmi";
import { polygon } from "wagmi/chains";

// Admin wallet (same as /market)
const ADMIN_ADDRESS = "0x1E025245946191c40DcE3bBb3784494eD79BAe16";

type Asset = {
  assetId: string;
  polarity: "POS" | "NEG" | "UNKNOWN";
  side: "YES" | "NO";
  indexSet: string;
  tokenId: string;
  conditionId: string;
  title: string | null;
  polymarketUrl: string | null;
  midpoint: number | null;
};

type ClassEntry = {
  classId: string;
  pos: Asset[];
  neg: Asset[];
};

type ApiResponse = {
  updatedAt: string;
  fromBlock: string;
  classes: ClassEntry[];
};

function short(x: string) {
  return `${x.slice(0, 10)}…${x.slice(-8)}`;
}

export default function EquivClassWorkspacePage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const { classId: rawClassId } = use(params);
  const classId = decodeURIComponent(rawClassId);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onPolygon = chainId === polygon.id;

  const isAdmin = useMemo(() => {
    if (!isConnected || !onPolygon || !address) return false;
    return address.toLowerCase() === ADMIN_ADDRESS.toLowerCase();
  }, [address, isConnected, onPolygon]);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/correl/equiv-classes")
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const cls = useMemo(() => {
    if (!data) return null;
    return data.classes.find(
      (c) => c.classId.toLowerCase() === classId.toLowerCase(),
    );
  }, [data, classId]);

  const assetCount = (cls?.pos?.length ?? 0) + (cls?.neg?.length ?? 0);

  return (
    <main
      style={{
        background: "white",
        color: "black",
        minHeight: "100vh",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          marginBottom: 12,
          display: "flex",
          gap: 12,
          alignItems: "center",
        }}
      >
        <Link href="/equiv-classes">
          <button>← Back</button>
        </Link>

        {isAdmin && (
          <Link
            href={`/market?classId=${encodeURIComponent(classId)}`}
            title="Add a market into this equivalence class"
          >
            <button>＋ Add Market</button>
          </Link>
        )}
      </div>

      <h1>Equivalence Class Workspace</h1>

      <div style={{ fontSize: 12, marginBottom: 16 }}>
        <div style={{ fontFamily: "monospace" }}>classId: {classId}</div>
        {!loading && data && (
          <div>
            fromBlock: {data.fromBlock} • updated{" "}
            {new Date(data.updatedAt).toLocaleString()}
          </div>
        )}
      </div>

      {loading && <div>Loading…</div>}

      {!loading && data && !cls && <div>Class not found in API response.</div>}

      {!loading && cls && (
        <>
          <div style={{ fontSize: 12, marginBottom: 12 }}>
            {assetCount} assets • POS: {cls.pos.length} • NEG: {cls.neg.length}
          </div>

          {/* -------- Workspace Sections -------- */}
          <div
            style={{
              border: "1px solid #ddd",
              padding: 12,
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Swap</div>
            <div style={{ fontSize: 12 }}>
              (Placeholder) This is where you’ll build swapping UI for this
              class.
            </div>
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              padding: 12,
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Redeem</div>
            <div style={{ fontSize: 12 }}>
              (Placeholder) This is where you’ll build redeem UI for this class.
            </div>
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              padding: 12,
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Assets</div>

            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}
            >
              <thead>
                <tr>
                  <th align="left">Market</th>
                  <th align="left">Side</th>
                  <th align="left">Midpoint</th>
                  <th align="left">conditionId</th>
                  <th align="left">tokenId</th>
                  <th align="left">Link</th>
                </tr>
              </thead>

              <tbody>
                {/* POS */}
                <tr>
                  <td colSpan={6} style={{ paddingTop: 10, fontWeight: 600 }}>
                    POS
                  </td>
                </tr>
                {(cls.pos ?? []).map((m) => (
                  <tr key={m.assetId}>
                    <td>{m.title ?? "(no title)"}</td>
                    <td>{m.side}</td>
                    <td>{m.midpoint == null ? "—" : m.midpoint.toFixed(4)}</td>
                    <td style={{ fontFamily: "monospace" }}>
                      {short(m.conditionId)}
                    </td>
                    <td style={{ fontFamily: "monospace" }}>
                      {short(m.tokenId)}
                    </td>
                    <td>
                      {m.polymarketUrl ? (
                        <a
                          href={m.polymarketUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}

                {/* NEG */}
                <tr>
                  <td colSpan={6} style={{ paddingTop: 10, fontWeight: 600 }}>
                    NEG
                  </td>
                </tr>
                {(cls.neg ?? []).map((m) => (
                  <tr key={m.assetId}>
                    <td>{m.title ?? "(no title)"}</td>
                    <td>{m.side}</td>
                    <td>{m.midpoint == null ? "—" : m.midpoint.toFixed(4)}</td>
                    <td style={{ fontFamily: "monospace" }}>
                      {short(m.conditionId)}
                    </td>
                    <td style={{ fontFamily: "monospace" }}>
                      {short(m.tokenId)}
                    </td>
                    <td>
                      {m.polymarketUrl ? (
                        <a
                          href={m.polymarketUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              padding: 12,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              Aggregated Order Book
            </div>
            <div style={{ fontSize: 12 }}>
              (Placeholder) Later: show the aggregated order book for this
              equivalence class.
            </div>
          </div>
        </>
      )}
    </main>
  );
}
