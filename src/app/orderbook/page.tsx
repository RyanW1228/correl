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

type SortKey = "asset" | "qty" | "price" | "fee";
type DirKey = "asc" | "desc";

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

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function isSortKey(v: string): v is SortKey {
  return v === "asset" || v === "qty" || v === "price" || v === "fee";
}

function isDirKey(v: string): v is DirKey {
  return v === "asc" || v === "desc";
}

function shortHex(id: string, head = 10, tail = 8) {
  const s = id.trim();
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function tryParseBigIntString(s: string): bigint | null {
  const t = s.trim();
  if (!t) return null;
  // allow only digits (raw integer string)
  if (!/^\d+$/.test(t)) return null;
  try {
    return BigInt(t);
  } catch {
    return null;
  }
}

function formatBigIntWithCommas(x: bigint) {
  const s = x.toString();
  // manual commas to avoid locale surprises in server env
  let out = "";
  let i = 0;
  for (let k = s.length - 1; k >= 0; k--) {
    out = s[k] + out;
    i++;
    if (i % 3 === 0 && k !== 0) out = "," + out;
  }
  return out;
}

function safeNumberString(s: string): number | null {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtPriceCell(priceUsdPerToken?: string) {
  if (!priceUsdPerToken) return null;
  const n = safeNumberString(priceUsdPerToken);
  if (n === null) return priceUsdPerToken; // fall back to raw
  // show 4dp for typical prediction-market style prices
  return n.toFixed(4);
}

function fmtFeePct(bps: number) {
  // e.g. 15 bps -> 0.15%
  return (bps / 100).toFixed(2) + "%";
}

function buildOrderbookUrl(params: {
  q: string | null;
  sort: SortKey;
  dir: DirKey;
  limit: number;
}) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  sp.set("sort", params.sort);
  sp.set("dir", params.dir);
  sp.set("limit", String(params.limit));
  return `/orderbook?${sp.toString()}`;
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

  const sortRaw = getStr(sp, "sort") ?? "asset";
  const dirRaw = getStr(sp, "dir") ?? "asc";
  const limitRaw = getInt(sp, "limit") ?? 200;

  const sort: SortKey = isSortKey(sortRaw) ? sortRaw : "asset";
  const dir: DirKey = isDirKey(dirRaw) ? dirRaw : "asc";
  const limit = clampInt(limitRaw, 1, 2000);

  // Forward only the keys we support (keeps things predictable)
  const forward = new URLSearchParams();
  if (q) forward.set("q", q);
  forward.set("sort", sort);
  forward.set("dir", dir);
  forward.set("limit", String(limit));

  const apiPath = `/api/orderbook?${forward.toString()}`;

  let data: OrderBookResponse | null = null;
  let error: string | null = null;
  let fetchMs: number | null = null;

  const t0 = Date.now();
  try {
    // Relative fetch works in Next.js App Router server components.
    // If your deployment needs absolute URLs, switch to:
    //   const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    //   fetch(`${base}${apiPath}`, ...)
    const res = await fetch(apiPath, {
      // Order books change often; avoid caching by default.
      cache: "no-store",
    });
    fetchMs = Date.now() - t0;

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
    fetchMs = Date.now() - t0;
    error = e?.message
      ? String(e.message)
      : "Unknown error fetching order book.";
  }

  const rows = data?.rows ?? [];

  // Derived stats (no assumptions about decimals)
  const qtyParsed = rows
    .map((r) => tryParseBigIntString(r.availableQty))
    .filter((x): x is bigint => x !== null);

  const totalQty =
    qtyParsed.length > 0
      ? qtyParsed.reduce((acc, x) => acc + x, BigInt(0))
      : null;

  const invalidQtyCount = rows.length - qtyParsed.length;

  const polarityCounts = rows.reduce(
    (acc, r) => {
      if (r.polarity === "POS") acc.pos++;
      else if (r.polarity === "NEG") acc.neg++;
      else acc.unknown++;
      return acc;
    },
    { pos: 0, neg: 0, unknown: 0 },
  );

  const hasPerRowUpdatedAt = rows.some((r) => !!r.updatedAt);

  function nextDirFor(col: SortKey) {
    // If clicking the active column, toggle direction; otherwise default to asc.
    if (sort === col) return dir === "asc" ? "desc" : "asc";
    return "asc";
  }

  function headerLink(col: SortKey) {
    const href = buildOrderbookUrl({
      q,
      sort: col,
      dir: nextDirFor(col),
      limit,
    });
    const active = sort === col;
    const arrow = active ? (dir === "asc" ? " ↑" : " ↓") : "";
    return { href, active, arrow };
  }

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

      {/* Summary / Diagnostics Bar */}
      <section
        style={{
          marginTop: 14,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={pillStyle}>
          <span style={pillLabelStyle}>Rows</span>{" "}
          <span style={pillValueStyle}>{rows.length}</span>
        </div>
        <div style={pillStyle}>
          <span style={pillLabelStyle}>POS</span>{" "}
          <span style={pillValueStyle}>{polarityCounts.pos}</span>
        </div>
        <div style={pillStyle}>
          <span style={pillLabelStyle}>NEG</span>{" "}
          <span style={pillValueStyle}>{polarityCounts.neg}</span>
        </div>
        <div style={pillStyle}>
          <span style={pillLabelStyle}>Unknown</span>{" "}
          <span style={pillValueStyle}>{polarityCounts.unknown}</span>
        </div>
        <div style={pillStyle}>
          <span style={pillLabelStyle}>Total Qty</span>{" "}
          <span style={pillValueStyle}>
            {totalQty !== null ? formatBigIntWithCommas(totalQty) : "—"}
          </span>
        </div>
        <div style={pillStyle}>
          <span style={pillLabelStyle}>Invalid Qty</span>{" "}
          <span style={pillValueStyle}>{invalidQtyCount}</span>
        </div>
        <div style={pillStyle}>
          <span style={pillLabelStyle}>Fetch</span>{" "}
          <span style={pillValueStyle}>
            {typeof fetchMs === "number" ? `${fetchMs}ms` : "—"}
          </span>
        </div>
      </section>

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

          {/* Quick links */}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <a
              href={buildOrderbookUrl({
                q: null,
                sort: "asset",
                dir: "asc",
                limit,
              })}
              style={linkButtonStyle}
              title="Clear filters"
            >
              Reset
            </a>
            <a
              href={`/api/orderbook?${forward.toString()}`}
              style={linkButtonStyle}
              title="Open raw JSON response"
            >
              View JSON
            </a>
          </div>

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
            <div style={{ marginTop: 10, opacity: 0.8, fontSize: 13 }}>
              Tip: click <strong>View JSON</strong> above to see exactly what
              your route returns.
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
                  <th style={thStyle}>
                    <a
                      href={headerLink("asset").href}
                      style={headerLink("asset").active ? thLinkActive : thLink}
                      title="Sort by asset"
                    >
                      Asset{headerLink("asset").arrow}
                    </a>
                  </th>
                  <th style={thStyle}>Polarity</th>
                  <th style={thStyleRight}>
                    <a
                      href={headerLink("qty").href}
                      style={headerLink("qty").active ? thLinkActive : thLink}
                      title="Sort by available quantity"
                    >
                      Available Qty{headerLink("qty").arrow}
                    </a>
                  </th>
                  <th style={thStyleRight}>
                    <a
                      href={headerLink("price").href}
                      style={headerLink("price").active ? thLinkActive : thLink}
                      title="Sort by price"
                    >
                      Price{headerLink("price").arrow}
                    </a>
                  </th>
                  <th style={thStyleRight}>
                    <a
                      href={headerLink("fee").href}
                      style={headerLink("fee").active ? thLinkActive : thLink}
                      title="Sort by fee"
                    >
                      Fee (bps){headerLink("fee").arrow}
                    </a>
                  </th>
                  {hasPerRowUpdatedAt ? (
                    <th style={thStyleRight}>Row Updated</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={hasPerRowUpdatedAt ? 6 : 5}
                      style={{ padding: 14, opacity: 0.75 }}
                    >
                      No rows returned.
                    </td>
                  </tr>
                ) : (
                  rows.map((r, idx) => {
                    const qtyBI = tryParseBigIntString(r.availableQty);
                    const qtyPretty =
                      qtyBI !== null ? formatBigIntWithCommas(qtyBI) : null;

                    const pricePretty = fmtPriceCell(r.priceUsdPerToken);

                    return (
                      <tr
                        key={r.assetId}
                        style={{
                          borderTop: "1px solid rgba(0,0,0,0.08)",
                          background:
                            idx % 2 === 1 ? "rgba(0,0,0,0.015)" : "transparent",
                        }}
                      >
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 650 }}>
                            {r.label ?? shortHex(r.assetId)}
                          </div>
                          <div
                            style={{ opacity: 0.7, fontSize: 12, marginTop: 2 }}
                          >
                            <span title={r.assetId}>
                              {r.label
                                ? r.assetId
                                : shortHex(r.assetId, 14, 10)}
                            </span>
                          </div>
                        </td>

                        <td style={tdStyle}>
                          {r.polarity ? (
                            <span
                              style={{
                                padding: "3px 8px",
                                borderRadius: 999,
                                border: "1px solid rgba(0,0,0,0.15)",
                                fontSize: 12,
                                fontWeight: 700,
                              }}
                            >
                              {r.polarity}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>

                        <td style={tdStyleRight}>
                          <div>
                            <code style={codeStyle}>{r.availableQty}</code>
                          </div>
                          <div
                            style={{
                              opacity: 0.75,
                              fontSize: 12,
                              marginTop: 3,
                            }}
                          >
                            {qtyPretty ? `≈ ${qtyPretty}` : "—"}
                          </div>
                        </td>

                        <td style={tdStyleRight}>
                          {pricePretty ? (
                            <>
                              <div>
                                <code style={codeStyle}>{pricePretty}</code>
                              </div>
                              {/* Helpful hint if price looks like prob in [0,1] */}
                              {(() => {
                                if (!r.priceUsdPerToken) return null;
                                const n = safeNumberString(r.priceUsdPerToken); // number | null
                                if (n === null) return null;

                                if (n >= 0 && n <= 1) {
                                  return (
                                    <div
                                      style={{
                                        opacity: 0.75,
                                        fontSize: 12,
                                        marginTop: 3,
                                      }}
                                    >
                                      {(n * 100).toFixed(2)}%
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </>
                          ) : (
                            "-"
                          )}
                        </td>

                        <td style={tdStyleRight}>
                          {typeof r.feeBps === "number" ? (
                            <>
                              <div>{r.feeBps}</div>
                              <div
                                style={{
                                  opacity: 0.75,
                                  fontSize: 12,
                                  marginTop: 3,
                                }}
                              >
                                {fmtFeePct(r.feeBps)}
                              </div>
                            </>
                          ) : (
                            "-"
                          )}
                        </td>

                        {hasPerRowUpdatedAt ? (
                          <td style={tdStyleRight}>
                            {r.updatedAt ? (
                              <code style={codeStyle}>{r.updatedAt}</code>
                            ) : (
                              "-"
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            {/* Footer hint */}
            <div
              style={{
                padding: "10px 14px",
                borderTop: "1px solid rgba(0,0,0,0.08)",
                fontSize: 13,
                opacity: 0.8,
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                Tip: click column headers to sort. Your API route can ignore
                sort/dir, but supporting them makes this page much more useful.
              </div>
              <div>
                Showing <strong>{rows.length}</strong> row
                {rows.length === 1 ? "" : "s"} (limit <strong>{limit}</strong>)
              </div>
            </div>
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
  whiteSpace: "nowrap",
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

const pillStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 999,
  border: "1px solid rgba(0,0,0,0.12)",
  background: "rgba(0,0,0,0.02)",
  display: "inline-flex",
  gap: 8,
  alignItems: "center",
};

const pillLabelStyle: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
};

const pillValueStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
};

const thLink: React.CSSProperties = {
  color: "inherit",
  textDecoration: "none",
};

const thLinkActive: React.CSSProperties = {
  color: "inherit",
  textDecoration: "underline",
  textUnderlineOffset: 3,
};

const linkButtonStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(0,0,0,0.18)",
  cursor: "pointer",
  fontWeight: 600,
  textDecoration: "none",
  color: "inherit",
  display: "inline-flex",
  alignItems: "center",
  height: 40,
};
