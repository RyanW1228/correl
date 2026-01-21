import { NextResponse } from "next/server";
import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";

const CORREL_ADDRESS = process.env.NEXT_PUBLIC_CORREL_ADDRESS as
  | Address
  | undefined;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL as string | undefined;
const CORREL_DEPLOY_BLOCK_RAW = process.env.CORREL_DEPLOY_BLOCK as
  | string
  | undefined;

/* ---------------- ABI ---------------- */

const CORREL_ABI = parseAbi([
  "function assets(bytes32 assetId) view returns (address token, uint256 tokenId, bytes32 classId, uint8 polarity, bool exists, bytes32 conditionId, bytes32 parentCollectionId, address collateralToken, uint256 indexSet)",
]);

const ASSET_REGISTERED_EVENT = parseAbiItem(
  "event AssetRegistered(bytes32 indexed assetId, address indexed token, uint256 tokenId, bytes32 indexed classId, uint8 polarity)",
);

/* ---------------- Types ---------------- */

type GammaMarket = {
  question?: string | null;
  slug?: string | null;
  clobTokenIds?: string | string[] | null;

  bestBid?: number | string | null;
  bestAsk?: number | string | null;
};

type AssetRow = {
  assetId: Hex;
  classId: Hex;

  polarity: "POS" | "NEG" | "UNKNOWN";
  side: "YES" | "NO"; // 👈 ADD THIS

  token: Address;
  tokenId: string;
  conditionId: Hex;
  indexSet: string;

  title: string | null;
  slug: string | null;
  polymarketUrl: string | null;
  clobTokenIds: { yes: string | null; no: string | null };

  midpoint: number | null; // 👈 ADD THIS
};

type ClassCard = {
  classId: Hex;
  pos: AssetRow[];
  neg: AssetRow[];
};

type ApiResponse = {
  updatedAt: string;
  source: "events+reads";
  chainId: number;
  correlAddress: Address;
  fromBlock: string;
  classes: ClassCard[];
};

/* ---------------- Cache ---------------- */

const CACHE_TTL_MS = 30_000;
let cache: { at: number; payload: ApiResponse } | null = null;

/* ---------------- Helpers ---------------- */

function requireEnv() {
  if (!CORREL_ADDRESS) throw new Error("Missing NEXT_PUBLIC_CORREL_ADDRESS");
  if (!POLYGON_RPC_URL) throw new Error("Missing POLYGON_RPC_URL");
  if (!CORREL_DEPLOY_BLOCK_RAW) throw new Error("Missing CORREL_DEPLOY_BLOCK");

  const n = Number(CORREL_DEPLOY_BLOCK_RAW);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("CORREL_DEPLOY_BLOCK must be a positive integer");
  }

  return {
    correlAddress: CORREL_ADDRESS,
    rpcUrl: POLYGON_RPC_URL,
    fromBlock: BigInt(n),
  };
}

function polarityToLabel(p: number): "POS" | "NEG" | "UNKNOWN" {
  if (p === 0) return "POS";
  if (p === 1) return "NEG";
  return "UNKNOWN";
}

function indexSetToSide(indexSet: bigint): "YES" | "NO" {
  // Polymarket binary: YES=1, NO=2
  return indexSet === BigInt(1) ? "YES" : "NO";
}

function parseGammaClobTokenIds(
  raw: GammaMarket["clobTokenIds"],
): string[] | null {
  if (!raw) return null;

  if (Array.isArray(raw)) return raw.map(String);

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }

  return null;
}

/* ---------------- Gamma lookup (CORRECT) ---------------- */

async function fetchGammaMarketByClobTokenId(
  clobTokenId: string,
): Promise<{ market: GammaMarket; clobs: string[] | null } | null> {
  const url = `https://gamma-api.polymarket.com/markets?clob_token_ids=${encodeURIComponent(
    clobTokenId,
  )}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;

  const json = (await res.json()) as unknown;
  if (!Array.isArray(json) || json.length === 0) return null;

  const market = json[0] as GammaMarket;
  const clobs = parseGammaClobTokenIds(market.clobTokenIds);

  return { market, clobs };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function enforceNoMidpointIsOneMinusYes(rows: AssetRow[]) {
  // Group by market (conditionId)
  const byCondition = new Map<string, AssetRow[]>();
  for (const r of rows) {
    const key = r.conditionId.toLowerCase();
    const arr = byCondition.get(key) ?? [];
    arr.push(r);
    byCondition.set(key, arr);
  }

  for (const arr of byCondition.values()) {
    const yes = arr.find((x) => x.side === "YES" && x.midpoint != null);
    const no = arr.find((x) => x.side === "NO");

    if (!yes || yes.midpoint == null || !no) continue;

    // Force complement rule
    no.midpoint = 1 - yes.midpoint;
  }
}

/* ---------------- Route ---------------- */

export async function GET(req: Request) {
  try {
    const { correlAddress, rpcUrl, fromBlock } = requireEnv();
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";

    if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json(cache.payload);
    }

    const client = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl),
    });

    /* 1. Discover assets from events */

    const logs = await client.getLogs({
      address: correlAddress,
      event: ASSET_REGISTERED_EVENT,
      fromBlock,
      toBlock: "latest",
    });

    const assetIds = Array.from(
      new Set(
        logs
          .map((l) => l.args.assetId)
          .filter((x): x is Hex => typeof x === "string"),
      ),
    );

    /* 2. Read assets + hydrate from Gamma */

    const rows: AssetRow[] = [];

    for (const batch of chunk(assetIds, 25)) {
      const results = await Promise.all(
        batch.map(async (assetId) => {
          const [
            token,
            tokenId,
            classId,
            polarity,
            exists,
            conditionId,
            _,
            __,
            indexSet,
          ] = await client.readContract({
            address: correlAddress,
            abi: CORREL_ABI,
            functionName: "assets",
            args: [assetId],
          });

          if (!exists) return null;

          let title: string | null = null;
          let slug: string | null = null;
          let polymarketUrl: string | null = null;
          let clobYes: string | null = null;
          let clobNo: string | null = null;
          let midpoint: number | null = null;

          try {
            const gmRes = await fetchGammaMarketByClobTokenId(
              (tokenId as bigint).toString(),
            );

            if (gmRes) {
              const gm = gmRes.market;

              title = gm.question ?? null;
              slug = gm.slug ?? null;
              if (slug) polymarketUrl = `https://polymarket.com/market/${slug}`;

              const clobs = gmRes.clobs;
              if (clobs && clobs.length >= 2) {
                clobYes = clobs[0];
                clobNo = clobs[1];
              }

              const bid = gm.bestBid != null ? Number(gm.bestBid) : null;
              const ask = gm.bestAsk != null ? Number(gm.bestAsk) : null;
              midpoint = bid != null && ask != null ? (bid + ask) / 2 : null;
            }
          } catch {}

          return {
            assetId,
            classId: classId as Hex,
            polarity: polarityToLabel(Number(polarity)),
            side: indexSetToSide(indexSet as bigint),
            token: token as Address,
            tokenId: (tokenId as bigint).toString(),
            conditionId: conditionId as Hex,
            indexSet: (indexSet as bigint).toString(),
            title,
            slug,
            polymarketUrl,
            clobTokenIds: { yes: clobYes, no: clobNo },
            midpoint,
          };
        }),
      );

      for (const r of results) if (r) rows.push(r);
    }

    enforceNoMidpointIsOneMinusYes(rows);

    /* 3. Group by classId */

    const byClass = new Map<string, AssetRow[]>();
    for (const r of rows) {
      const key = r.classId.toLowerCase();
      (byClass.get(key) ?? byClass.set(key, []).get(key)!).push(r);
    }

    const classes: ClassCard[] = Array.from(byClass.values()).map(
      (markets) => ({
        classId: markets[0]!.classId,
        pos: markets.filter((m) => m.polarity === "POS"),
        neg: markets.filter((m) => m.polarity === "NEG"),
      }),
    );

    const payload: ApiResponse = {
      updatedAt: new Date().toISOString(),
      source: "events+reads",
      chainId: polygon.id,
      correlAddress,
      fromBlock: fromBlock.toString(),
      classes,
    };

    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
