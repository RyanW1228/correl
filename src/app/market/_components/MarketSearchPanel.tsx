// src/app/market/_components/MarketSearchPanel.tsx

"use client";

import React, { useMemo, useState } from "react";

type SelectedMarket = {
  title: string;
  slug?: string;
  conditionId?: string; // bytes32

  yesTokenId?: string; // uint256 as string
  noTokenId?: string; // uint256 as string
  clobTokenIds?: string[]; // fallback list for dropdown
};

type MarketInEvent = {
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
  markets: MarketInEvent[];
};

type SearchApiResponse = {
  results?: unknown;
  error?: string;
};

function normalizeTokenIds(x: unknown): string[] | undefined {
  // already string[]
  if (Array.isArray(x) && x.every((v) => typeof v === "string")) return x;

  // JSON string array e.g. '["a","b"]' OR a single string id
  if (typeof x === "string") {
    const s = x.trim();
    if (!s) return undefined;

    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (
          Array.isArray(parsed) &&
          parsed.every((v) => typeof v === "string")
        ) {
          return parsed;
        }
      } catch {}
    }

    return [s];
  }

  return undefined;
}

async function fetchMarketBySlug(slug: string): Promise<{
  raw: any;
  conditionId?: string;
  clobTokenIds?: string[];
  yesTokenId?: string;
  noTokenId?: string;
}> {
  const url = `/api/polymarket/market-by-slug?slug=${encodeURIComponent(slug)}`;

  const res = await fetch(url, { cache: "no-store" });

  // If this fails, it’s now your own API route failing (much easier to debug).
  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {}
    throw new Error(
      `market-by-slug failed (${res.status})${bodyText ? `: ${bodyText}` : ""}`,
    );
  }

  const raw = await res.json();

  // Keep your existing normalization logic
  const first = Array.isArray(raw)
    ? raw[0]
    : Array.isArray((raw as any)?.markets)
      ? (raw as any).markets[0]
      : raw;

  const conditionId =
    typeof first?.conditionId === "string" ? first.conditionId : undefined;

  const clobTokenIds = normalizeTokenIds(first?.clobTokenIds);
  const yesTokenId = clobTokenIds?.[0];
  const noTokenId = clobTokenIds?.[1];

  return { raw, conditionId, clobTokenIds, yesTokenId, noTokenId };
}

type Props = {
  onSelectMarket: (m: SelectedMarket) => void;
};

export function MarketSearchPanel({ onSelectMarket }: Props) {
  const [q, setQ] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [events, setEvents] = useState<EventResult[]>([]);
  const [activeEventIdx, setActiveEventIdx] = useState(0);

  // Debug / confirmation JSON panel
  const [selectedSlug, setSelectedSlug] = useState("");
  const [marketDetailJson, setMarketDetailJson] = useState("");

  function clearResultsUI() {
    setEvents([]);
    setActiveEventIdx(0);
    setSelectedSlug("");
    setMarketDetailJson("");
  }

  const activeEvent = useMemo(() => {
    if (events.length === 0) return null;
    const idx = Math.min(Math.max(activeEventIdx, 0), events.length - 1);
    return events[idx] ?? null;
  }, [events, activeEventIdx]);

  async function onSearch() {
    const query = q.trim();
    if (!query) return;

    setSearchError("");
    setSearchLoading(true);
    setEvents([]);
    setActiveEventIdx(0);
    setSelectedSlug("");
    setMarketDetailJson("");

    try {
      const url = `/api/polymarket/search?q=${encodeURIComponent(
        query,
      )}&limit=10`;

      const res = await fetch(url, { cache: "no-store" });

      if (!res.ok) {
        let bodyText = "";
        try {
          bodyText = await res.text();
        } catch {}
        throw new Error(
          `Search API failed (${res.status})${bodyText ? `: ${bodyText}` : ""}`,
        );
      }

      const data = (await res.json()) as SearchApiResponse;

      const rawResults = (data as any)?.results;
      const rawArray = Array.isArray(rawResults) ? rawResults : [];

      // Keep ONLY event results (your current route returns events; this also guards against mixed results)
      const nextEvents = rawArray.filter(
        (r: any) => r && r.kind === "event" && typeof r.title === "string",
      ) as EventResult[];

      setEvents(nextEvents);
      setActiveEventIdx(0);
    } catch (e: any) {
      setSearchError(e?.message ?? "Search failed");
    } finally {
      setSearchLoading(false);
    }
  }

  async function onLoadMarketJson(slug: string | undefined) {
    const s = (slug ?? "").trim();
    if (!s) {
      setSearchError("Missing market slug (cannot load market JSON).");
      return;
    }

    setSearchError("");
    setSelectedSlug(s);
    setMarketDetailJson("");

    try {
      const hydrated = await fetchMarketBySlug(s);
      setMarketDetailJson(JSON.stringify(hydrated.raw, null, 2));
    } catch (e: any) {
      setSearchError(e?.message ?? "Market fetch failed");
    }
  }

  async function onSelect(m: MarketInEvent) {
    setSearchError("");

    const baseTokenIds = normalizeTokenIds(m.clobTokenIds);
    const base: SelectedMarket = {
      title: m.title,
      slug: m.slug,
      conditionId: m.conditionId,
      clobTokenIds: baseTokenIds,
      yesTokenId: baseTokenIds?.[0],
      noTokenId: baseTokenIds?.[1],
    };

    // Prefer to hydrate from Gamma so IDs are correct for equivalence class usage
    if (m.slug) {
      try {
        const hydrated = await fetchMarketBySlug(m.slug);
        const pickedClob = hydrated.clobTokenIds ?? base.clobTokenIds;
        const picked: SelectedMarket = {
          ...base,
          conditionId: hydrated.conditionId ?? base.conditionId,
          clobTokenIds: pickedClob,
          yesTokenId: hydrated.yesTokenId ?? pickedClob?.[0] ?? base.yesTokenId,
          noTokenId: hydrated.noTokenId ?? pickedClob?.[1] ?? base.noTokenId,
        };

        // Also show JSON in the debug panel
        setSelectedSlug(m.slug);
        setMarketDetailJson(JSON.stringify(hydrated.raw, null, 2));

        onSelectMarket(picked);
        clearResultsUI();
        return;
      } catch (e: any) {
        // If hydration fails, still allow selection (but warn)
        setSearchError(
          e?.message ??
            "Failed to hydrate selected market; selecting with event-provided fields.",
        );
      }
    } else {
      setSearchError(
        "Selected market has no slug; selecting with event-provided fields.",
      );
    }

    onSelectMarket(base);
    clearResultsUI();
  }

  return (
    <div style={{ marginTop: 16, marginBottom: 24 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>
        Search Polymarket (via /api/polymarket/search)
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. super bowl"
          style={{ width: 520, maxWidth: "100%" }}
        />
        <button onClick={onSearch} disabled={searchLoading}>
          {searchLoading ? "Searching..." : "Search"}
        </button>
      </div>

      {searchError && (
        <div style={{ color: "red", marginTop: 8 }}>{searchError}</div>
      )}

      {events.length === 0 && !searchLoading && (
        <div style={{ marginTop: 8 }}>(no results yet)</div>
      )}

      {events.length > 0 && activeEvent && (
        <div style={{ marginTop: 12 }}>
          {/* Pager */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => setActiveEventIdx((i) => Math.max(0, i - 1))}
              disabled={activeEventIdx <= 0}
              aria-label="Previous event"
            >
              ←
            </button>

            <div style={{ fontWeight: 700 }}>
              Event {Math.min(activeEventIdx + 1, events.length)} /{" "}
              {events.length}
            </div>

            <button
              onClick={() =>
                setActiveEventIdx((i) => Math.min(events.length - 1, i + 1))
              }
              disabled={activeEventIdx >= events.length - 1}
              aria-label="Next event"
            >
              →
            </button>

            {activeEvent.url && (
              <a
                href={activeEvent.url}
                target="_blank"
                rel="noreferrer"
                style={{ marginLeft: 8 }}
              >
                Open event
              </a>
            )}
          </div>

          {/* Active event */}
          <div
            style={{
              borderTop: "1px solid black",
              paddingTop: 12,
              marginTop: 12,
            }}
          >
            <div style={{ fontWeight: 700 }}>
              Event: {activeEvent.title}{" "}
              <span style={{ fontWeight: 400 }}>
                ({activeEvent.marketsCount} markets)
              </span>
            </div>

            {/* Markets */}
            <div style={{ marginTop: 10, paddingLeft: 12 }}>
              {activeEvent.markets.length === 0 && (
                <div style={{ marginTop: 8 }}>(no markets in this event)</div>
              )}

              {activeEvent.markets.map((m, j) => (
                <div
                  key={`ev-${activeEvent.eventId}-m-${m.marketId}-${j}`}
                  style={{
                    borderTop: "1px dashed #999",
                    marginTop: 8,
                    paddingTop: 8,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{m.title}</div>

                  <div style={{ fontFamily: "monospace" }}>
                    slug: {m.slug ?? "(missing)"}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    conditionId: {m.conditionId ?? "(missing)"}
                  </div>
                  <div style={{ fontFamily: "monospace" }}>
                    clobTokenIds: {m.clobTokenIds?.join(", ") ?? "(missing)"}
                  </div>

                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <button type="button" onClick={() => onSelect(m)}>
                      Select market (for equivalence class)
                    </button>

                    <button
                      type="button"
                      onClick={() => onLoadMarketJson(m.slug)}
                      disabled={!m.slug}
                    >
                      Load full market JSON
                    </button>

                    <a
                      href={
                        m.slug
                          ? `https://polymarket.com/market/${m.slug}`
                          : "https://polymarket.com"
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open market
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Debug panel */}
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
      )}
    </div>
  );
}
