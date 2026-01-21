// src/app/api/polymarket/market-by-slug/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const slug = (searchParams.get("slug") ?? "").trim();

    if (!slug) {
      return NextResponse.json(
        { error: "Missing required query param: slug" },
        { status: 400 },
      );
    }

    const upstreamUrl = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(
      slug,
    )}`;

    const upstreamRes = await fetch(upstreamUrl, {
      // avoid caching surprises in dev
      cache: "no-store",
      headers: {
        // some upstreams behave better with a UA
        "User-Agent": "correl/market-by-slug",
      },
    });

    const text = await upstreamRes.text();

    // Try to parse JSON; if upstream gives non-JSON, surface that clearly.
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          error: `Upstream returned non-JSON (status ${upstreamRes.status})`,
          upstreamStatus: upstreamRes.status,
          bodyPreview: text.slice(0, 500),
        },
        { status: 502 },
      );
    }

    if (!upstreamRes.ok) {
      return NextResponse.json(
        {
          error: `Upstream gamma-api error (${upstreamRes.status})`,
          upstreamStatus: upstreamRes.status,
          upstreamBody: json,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(json, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown server error" },
      { status: 500 },
    );
  }
}
