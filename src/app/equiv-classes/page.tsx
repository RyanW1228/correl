// src/app/equiv-classes/page.tsx

"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";

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

export default function EquivClassesPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/correl/equiv-classes")
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

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
      <h1>Equivalence Classes</h1>

      <div style={{ marginBottom: 12 }}>
        <Link href="/">
          <button>← Home</button>
        </Link>
      </div>

      {loading && <div>Loading…</div>}

      {!loading && data && (
        <>
          <div style={{ fontSize: 12, marginBottom: 16 }}>
            fromBlock: {data.fromBlock} • updated{" "}
            {new Date(data.updatedAt).toLocaleString()}
          </div>

          {data.classes.map((cls) => {
            const href = `/equiv-classes/${encodeURIComponent(cls.classId)}`;

            return (
              <Link
                key={cls.classId}
                href={href}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div
                  style={{
                    border: "1px solid #ddd",
                    padding: 12,
                    marginBottom: 16,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>classId: {cls.classId}</div>
                  <div style={{ fontSize: 12, marginBottom: 8 }}>
                    {(cls.pos?.length ?? 0) + (cls.neg?.length ?? 0)} assets
                  </div>
                  {/* TODO: paste your existing table back here (removed placeholder "...") */}
                </div>
              </Link>
            );
          })}
        </>
      )}
    </main>
  );
}
