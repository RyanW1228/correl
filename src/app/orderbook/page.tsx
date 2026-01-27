// src/app/orderbook/page.tsx

import React from "react";

type OrderBookRow = {
  assetId: string; // bytes32 hex or any identifier you return
  label?: string; // e.g. "KC Chiefs @ -110 (YES)" (optional)
  polarity?: "POS" | "NEG"; // optional
  availableQty: string; // raw string so we don't guess decimals (e.g. "1230000")
  priceUsdPerToken?: string; // optional (e.g. "0.5234")
  feeBps?: number; // optional
  updatedAt?: string; // ISO string (optional)
};

type OrderBookResponse = {
  rows: OrderBookRow[];
  updatedAt?: string; // optional
};

function getStr(sp: URLSearchParams, key: string) {
  const v = sp.get(key);
  return v && v.trim().length > 0 ? v.trim() : null;
}

function getInt(sp: URLSearchParams, key: string) {
  const v = getStr(sp, key);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Order Book (Correl)
 *
 * This page intentionally does NOT assume any on-chain ABI/signatures.
 * It reads from an API route (you implement) at:
 *   GET /api/orderbook
 *
 * Query params forwarded:
 *   - q: filter string
 *   - sort: "asset" | "qty" | "price" | "fee"
 *   - dir: "asc" | "desc"
 *   - limit: number
 *
 * Expected JSON response:
 *   { rows: Array<{ assetId, label?, polarity?, availableQty, priceUsdPerToken?, feeBps?, updatedAt? }>, updatedAt? }
 */
export default async function OrderBookPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const sp = new URLSearchParams();

  // Normalize searchParams into URLSearchParams
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") sp.set(k, v);
    else if (Array.isArray(v)) sp.set(k, v[0] ?? "");
  }

  const q = getStr(sp, "q");
  const sort = getStr(sp, "sort") ?? "asset";
  const dir = getStr(sp, "dir") ?? "asc";
  const limit = getInt(sp, "limit") ?? 200;

  // Forward only the keys we support (keeps things predictable)
  const forward = new URLSearchParams();
  if (q) forward.set("q", q);
  if (sort) forward.set("sort", sort);
  if (dir) forward.set("dir", dir);
  forward.set("limit", String(limit));

  const apiPath = `/api/orderbook?${forward.toString()}`;

  let data: OrderBookResponse | null = null;
  let error: string | null = null;

  try {
    // Relative fetch works in Next.js App Router server components.
    // If your deployment needs absolute URLs, switch to:
    //   const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    //   fetch(`${base}${apiPath}`, ...)
    const res = await fetch(apiPath, {
      // Order books change often; avoid caching by default.
      cache: "no-store",
    });

    if (!res.ok) {
      error = `Order book API error: ${res.status} ${res.statusText}`;
    } else {
      data = (await res.json()) as OrderBookResponse;
      if (!data || !Array.isArray(data.rows)) {
        error =
          "Order book API returned invalid JSON shape (expected { rows: [...] }).";
        data = null;
      }
    }
  } catch (e: any) {
    error = e?.message
      ? String(e.message)
      : "Unknown error fetching order book.";
  }

  const rows = data?.rows ?? [];

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Order Book</h1>
        <span style={{ opacity: 0.7, fontSize: 13 }}>
          {data?.updatedAt ? `Updated ${data.updatedAt}` : ""}
        </span>
      </header>

      <p style={{ marginTop: 8, opacity: 0.8, lineHeight: 1.4 }}>
        This is Correl’s executable liquidity view (not a Polymarket CLOB). Data
        is served by <code>{apiPath}</code>.
      </p>

      <section style={{ marginTop: 18 }}>
        <form
          action="/orderbook"
          method="get"
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "center",
            padding: 12,
            border: "1px solid rgba(0,0,0,0.12)",
            borderRadius: 12,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Filter</span>
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="assetId / label"
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.18)",
                minWidth: 240,
              }}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Sort</span>
            <select
              name="sort"
              defaultValue={sort}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.18)",
              }}
            >
              <option value="asset">Asset</option>
              <option value="qty">Available Qty</option>
              <option value="price">Price</option>
              <option value="fee">Fee (bps)</option>
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Direction</span>
            <select
              name="dir"
              defaultValue={dir}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.18)",
              }}
            >
              <option value="asc">Asc</option>
              <option value="desc">Desc</option>
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Limit</span>
            <input
              name="limit"
              type="number"
              min={1}
              max={2000}
              step={1}
              defaultValue={limit}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.18)",
                width: 110,
              }}
            />
          </label>

          <button
            type="submit"
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.18)",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Apply
          </button>
        </form>
      </section>

      <section style={{ marginTop: 16 }}>
        {error ? (
          <div
            style={{
              padding: 14,
              borderRadius: 12,
              border: "1px solid rgba(255,0,0,0.25)",
              background: "rgba(255,0,0,0.04)",
              color: "rgba(0,0,0,0.85)",
              lineHeight: 1.4,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Couldn’t load order book
            </div>
            <div
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 13,
              }}
            >
              {error}
            </div>
            <div style={{ marginTop: 10, opacity: 0.8, fontSize: 13 }}>
              Implement <code>GET /api/orderbook</code> to return{" "}
              <code>{`{ rows: [...] }`}</code>.
            </div>
          </div>
        ) : (
          <div
            style={{
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "rgba(0,0,0,0.04)" }}>
                  <th style={thStyle}>Asset</th>
                  <th style={thStyle}>Polarity</th>
                  <th style={thStyleRight}>Available Qty</th>
                  <th style={thStyleRight}>Price</th>
                  <th style={thStyleRight}>Fee (bps)</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: 14, opacity: 0.75 }}>
                      No rows returned.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr
                      key={r.assetId}
                      style={{ borderTop: "1px solid rgba(0,0,0,0.08)" }}
                    >
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 650 }}>
                          {r.label ?? r.assetId}
                        </div>
                        {r.label ? (
                          <div
                            style={{ opacity: 0.7, fontSize: 12, marginTop: 2 }}
                          >
                            {r.assetId}
                          </div>
                        ) : null}
                      </td>
                      <td style={tdStyle}>{r.polarity ?? "-"}</td>
                      <td style={tdStyleRight}>
                        <code style={codeStyle}>{r.availableQty}</code>
                      </td>
                      <td style={tdStyleRight}>
                        {r.priceUsdPerToken ? (
                          <code style={codeStyle}>{r.priceUsdPerToken}</code>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td style={tdStyleRight}>
                        {typeof r.feeBps === "number" ? r.feeBps : "-"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 14px",
  fontSize: 12,
  letterSpacing: 0.2,
  opacity: 0.75,
  fontWeight: 700,
};

const thStyleRight: React.CSSProperties = {
  ...thStyle,
  textAlign: "right",
};

const tdStyle: React.CSSProperties = {
  padding: "12px 14px",
  verticalAlign: "top",
  fontSize: 14,
};

const tdStyleRight: React.CSSProperties = {
  ...tdStyle,
  textAlign: "right",
};

const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
};
