import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokenId = url.searchParams.get("token_id");

  if (!tokenId) {
    return NextResponse.json(
      { error: "Missing required query param: token_id" },
      { status: 400 },
    );
  }

  const upstream = `https://clob.polymarket.com/midpoint?token_id=${encodeURIComponent(
    tokenId,
  )}`;

  const res = await fetch(upstream, {
    method: "GET",
    // midpoint is fast-changing; avoid caching surprises
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Upstream error ${res.status}`, details: text },
      { status: 502 },
    );
  }

  const data = (await res.json()) as { mid?: string };

  const rawMidStr = (data.mid ?? "").trim();
  if (!rawMidStr) {
    return NextResponse.json({ tokenId, yesMid: null, noMid: null });
  }

  const rawMid = Number(rawMidStr);
  if (!Number.isFinite(rawMid)) {
    return NextResponse.json({ tokenId, yesMid: null, noMid: null });
  }

  // Polymarket midpoint is sometimes returned as 0..1, sometimes effectively cents-style.
  // You want cents-style 0..100.
  const yesMid = rawMid <= 1 ? rawMid * 100 : rawMid;

  // Clamp to [0,100] to avoid weird upstream edge cases.
  const yesMidClamped = Math.max(0, Math.min(100, yesMid));
  const noMid = 100 - yesMidClamped;

  // keep 4 decimals max (optional)
  const round = (x: number) => Math.round(x * 10000) / 10000;

  return NextResponse.json({
    tokenId,
    yesMid: round(yesMidClamped),
    noMid: round(noMid),
  });
}
