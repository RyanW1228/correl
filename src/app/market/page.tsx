"use client";

import React from "react";
import Link from "next/link";

type EquivalenceClassSection = {
  classId: string; // bytes32 hex string (or any unique id)
  title?: string; // optional human label
  assetIds: string[]; // bytes32 assetIds (optional for now)
};

const EQUIVALENCE_CLASSES: EquivalenceClassSection[] = [
  {
    classId:
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    title: "Equivalence Class 1",
    assetIds: [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
  },
  {
    classId:
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    title: "Equivalence Class 2",
    assetIds: [],
  },
];

export default function MarketPage() {
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

      {EQUIVALENCE_CLASSES.length === 0 && <div>(no equivalence classes)</div>}

      {EQUIVALENCE_CLASSES.map((eq) => (
        <div
          key={eq.classId}
          style={{
            marginTop: 16,
            paddingTop: 16,
            borderTop: "1px solid black",
          }}
        >
          <div style={{ fontWeight: 700 }}>
            {eq.title ?? "Equivalence Class"}
          </div>

          <div>classId: {eq.classId}</div>

          <div style={{ marginTop: 8, fontWeight: 700 }}>Assets</div>

          {eq.assetIds.length === 0 && <div>(none)</div>}

          {eq.assetIds.length > 0 &&
            eq.assetIds.map((assetId) => (
              <div key={assetId}>assetId: {assetId}</div>
            ))}
        </div>
      ))}
    </main>
  );
}
