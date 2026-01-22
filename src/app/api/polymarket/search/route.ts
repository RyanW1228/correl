// src/app/api/polymarket/search/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type GammaMarket = {
  id?: string | number;
  question?: string;
  marketTitle?: string;
  slug?: string;
  conditionId?: string;
  clobTokenIds?: string[] | string;

  // add these (best-effort; depends on Gamma payload)
  active?: boolean;
  closed?: boolean;
  resolved?: boolean;
  isResolved?: boolean;
  outcome?: string | null; // sometimes present when resolved
  endDate?: string | null;
};

type GammaEvent = {
  id?: string | number;
  title?: string;
  name?: string;
  slug?: string;
  markets?: Array<GammaMarket | null> | null;
};

function isResolvedOrClosed(m: GammaMarket): boolean {
  // explicit booleans if present
  if (m.isResolved === true) return true;
  if (m.resolved === true) return true;
  if (m.closed === true) return true;

  // some APIs use active=false to mean closed
  if (m.active === false) return true;

  // sometimes resolved markets have an "outcome"
  if (typeof m.outcome === "string" && m.outcome.trim()) return true;

  return false;
}

function firstNonEmpty(...xs: Array<string | undefined | null>) {
  for (const x of xs) {
    const v = (x ?? "").trim();
    if (v) return v;
  }
  return "";
}

function normalizeClobTokenIds(x: unknown): string[] | undefined {
  if (Array.isArray(x) && x.every((v) => typeof v === "string")) return x;
  if (typeof x === "string" && x.trim()) return [x.trim()];
  return undefined;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? "10"), 1),
    25,
  );

  if (!q) return NextResponse.json({ results: [] });

  const gamma = new URL("https://gamma-api.polymarket.com/public-search");
  gamma.searchParams.set("q", q);
  gamma.searchParams.set("limit_per_type", String(limit));
  gamma.searchParams.set("search_tags", "false");
  gamma.searchParams.set("search_profiles", "false");
  gamma.searchParams.set("keep_closed_markets", "0");
  gamma.searchParams.set("events_status", "active");

  try {
    const res = await fetch(gamma.toString(), {
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { results: [], error: `Gamma search failed: ${res.status}` },
        { status: 200 }, // keep frontend happy while you iterate
      );
    }

    const data = (await res.json()) as {
      events?: GammaEvent[] | null;
      markets?: GammaMarket[] | null;
    };

    const results = (data.events ?? []).slice(0, limit).map((ev) => {
      const eventTitle = firstNonEmpty(ev.title, ev.name, String(ev.id));
      const eventSlug = (ev.slug ?? "").trim();

      const marketsRaw = Array.isArray(ev.markets) ? ev.markets : [];

      const markets = marketsRaw
        .map((m) => {
          if (!m) return null;
          if (isResolvedOrClosed(m)) return null;

          const title = firstNonEmpty(m.question, m.marketTitle, String(m.id));
          if (!title) return null;

          const slug = (m.slug ?? "").trim();
          const conditionId = (m.conditionId ?? "").trim();
          const clobTokenIds = normalizeClobTokenIds(m.clobTokenIds);

          return {
            marketId: String(m.id ?? slug ?? conditionId ?? title),
            title,
            slug: slug || undefined,
            conditionId: conditionId || undefined,
            clobTokenIds,
            url: slug
              ? `https://polymarket.com/market/${slug}`
              : "https://polymarket.com",
          };
        })
        .filter(Boolean) as Array<{
        marketId: string;
        title: string;
        slug?: string;
        conditionId?: string;
        clobTokenIds?: string[];
        url?: string;
      }>;

      return {
        kind: "event" as const,
        eventId: String(ev.id ?? eventSlug ?? eventTitle),
        title: eventTitle,
        slug: eventSlug || undefined,
        url: eventSlug
          ? `https://polymarket.com/event/${eventSlug}`
          : "https://polymarket.com",
        marketsCount: markets.length,
        markets,
      };
    });

    return NextResponse.json({ results });
  } catch (e: any) {
    return NextResponse.json(
      { results: [], error: e?.message ?? "Unknown error" },
      { status: 200 },
    );
  }
}
