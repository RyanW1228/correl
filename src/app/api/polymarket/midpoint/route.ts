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
  return NextResponse.json({ mid: data.mid ?? null });
}
