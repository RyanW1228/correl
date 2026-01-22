// src/app/market/_components/useEquivalenceClassAdmin.ts

"use client";

import { useEffect, useMemo, useState } from "react";
import { useWriteContract } from "wagmi";
import { useWaitForTransactionReceipt } from "wagmi";

/* ---------------- Constants ---------------- */

const CORREL_ADDRESS = "0xd55963Bd90b14a2fE151C54788e58Ee84AA1F6dC" as const;

const DEFAULT_CTF_ADDRESS = (process.env.NEXT_PUBLIC_CTF ??
  "") as `0x${string}`;

const DEFAULT_COLLATERAL_ADDRESS = (process.env.NEXT_PUBLIC_USDC ??
  "") as `0x${string}`;

const DEFAULT_PARENT_COLLECTION_ID = ("0x" + "0".repeat(64)) as `0x${string}`;

const DEFAULT_INDEXSET_YES = BigInt(1);
const DEFAULT_INDEXSET_NO = BigInt(2);

const CorrelAdminAbi = [
  {
    name: "registerAsset",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assetId", type: "bytes32" },
      { name: "token", type: "address" }, // IERC1155
      { name: "tokenId", type: "uint256" },
      { name: "classId", type: "bytes32" },
      { name: "polarity", type: "uint8" }, // enum Polarity { POS=0, NEG=1 }
      { name: "conditionId", type: "bytes32" },
      { name: "indexSet", type: "uint256" },
      { name: "collateralToken", type: "address" }, // IERC20
      { name: "parentCollectionId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/* ---------------- Types ---------------- */

export type SelectedMarket = {
  title: string;
  slug?: string;
  conditionId?: string;
  yesTokenId?: string;
  noTokenId?: string;
  clobTokenIds?: string[];
};

export type ExistingAsset = {
  assetId: string;
  polarity: "POS" | "NEG" | "UNKNOWN";
  side: "YES" | "NO";
  tokenId: string;
  conditionId: string;
  title: string | null;
  polymarketUrl: string | null;
  midpoint: number | null;
};

export type ExistingClassEntry = {
  classId: string;
  pos: ExistingAsset[];
  neg: ExistingAsset[];
};

type ClassMode = "new" | "existing";

type RegisterAssetArgs = readonly [
  `0x${string}`, // assetId
  `0x${string}`, // token
  bigint, // tokenId
  `0x${string}`, // classId
  0 | 1, // polarity
  `0x${string}`, // conditionId
  bigint, // indexSet
  `0x${string}`, // collateralToken
  `0x${string}`, // parentCollectionId
];

/* ---------------- Helpers ---------------- */

function isBytes32Hex(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

function isAddress(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isDecimalTokenId(raw: string | undefined): raw is string {
  if (!raw) return false;
  return /^\d+$/.test(raw.trim());
}

function toBigIntStrict(raw: string): bigint | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  try {
    return BigInt(t);
  } catch {
    return null;
  }
}

function normalizeTokenIdList(raw: string[] | undefined): string[] {
  if (!raw) return [];

  const out: string[] = [];
  for (const item of raw) {
    const t = item.trim();

    if (t.startsWith("[") && t.endsWith("]")) {
      try {
        const arr = JSON.parse(t) as unknown;
        if (Array.isArray(arr)) {
          for (const v of arr) {
            if (typeof v === "string" && v.trim()) out.push(v.trim());
          }
          continue;
        }
      } catch {}
    }

    if (t) out.push(t);
  }

  return Array.from(new Set(out));
}

function randomBytes32(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as `0x${string}`;
}

function inferClassPolarityOrientation(entry: ExistingClassEntry): {
  inferred: "normal" | "flipped" | "unknown";
  posYes: number;
  posNo: number;
  negYes: number;
  negNo: number;
} {
  const pos = entry.pos ?? [];
  const neg = entry.neg ?? [];

  const posYes = pos.filter((a) => a.side === "YES").length;
  const posNo = pos.filter((a) => a.side === "NO").length;
  const negYes = neg.filter((a) => a.side === "YES").length;
  const negNo = neg.filter((a) => a.side === "NO").length;

  const total = pos.length + neg.length;
  if (total < 2) return { inferred: "unknown", posYes, posNo, negYes, negNo };

  const normalScore = posYes + negNo;
  const flippedScore = posNo + negYes;

  if (normalScore === flippedScore)
    return { inferred: "unknown", posYes, posNo, negYes, negNo };

  return {
    inferred: normalScore > flippedScore ? "normal" : "flipped",
    posYes,
    posNo,
    negYes,
    negNo,
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((p, q) => p - q);
  const mid = Math.floor(a.length / 2);
  if (a.length % 2 === 1) return a[mid];
  return (a[mid - 1] + a[mid]) / 2;
}

function finiteMids(xs: ExistingAsset[]): number[] {
  return (xs ?? [])
    .map((m) => m.midpoint)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

function toPctPoints(x: number): number {
  // If it looks like 0..1, convert to 0..100
  if (x >= 0 && x <= 1) return x * 100;
  return x;
}

/* ---------------- Hook ---------------- */

export function useEquivalenceClassAdmin(args: {
  selectedMarket: SelectedMarket | null;
  prefillClassId?: string | null;
}) {
  const { selectedMarket, prefillClassId } = args;

  // ---- register flow tracking ----
  const [registerPhase, setRegisterPhase] = useState<
    "idle" | "waitingPos" | "waitingNeg"
  >("idle");

  const [posTxHashForFlow, setPosTxHashForFlow] = useState<
    `0x${string}` | null
  >(null);

  // ---- class selection ----
  const [classMode, setClassMode] = useState<ClassMode>("new");
  const [newClassId, setNewClassId] = useState<string>(randomBytes32());
  const [selectedExistingClassId, setSelectedExistingClassId] =
    useState<string>("");
  const [showExistingDropdown, setShowExistingDropdown] = useState(false);

  const [existingClasses, setExistingClasses] = useState<ExistingClassEntry[]>(
    [],
  );
  const [existingLoadError, setExistingLoadError] = useState<string>("");

  useEffect(() => {
    const v = (prefillClassId ?? "").trim();
    if (!v) return;
    if (!isBytes32Hex(v)) return;

    setClassMode("existing");
    setSelectedExistingClassId(v);
    setShowExistingDropdown(false);
  }, [prefillClassId]);

  const effectiveClassId = useMemo(() => {
    return classMode === "new" ? newClassId : selectedExistingClassId;
  }, [classMode, newClassId, selectedExistingClassId]);

  const selectedClassEntry = useMemo(() => {
    const id = effectiveClassId.trim().toLowerCase();
    if (!id) return null;
    return existingClasses.find((c) => c.classId.toLowerCase() === id) ?? null;
  }, [effectiveClassId, existingClasses]);

  // ---- market token mapping ----
  const [assetIdPos, setAssetIdPos] = useState<string>(() => randomBytes32());
  const [assetIdNeg, setAssetIdNeg] = useState<string>(() => randomBytes32());

  const [pickedYesTokenId, setPickedYesTokenId] = useState<string>("");
  const [pickedNoTokenId, setPickedNoTokenId] = useState<string>("");
  const [flipPolarity, setFlipPolarity] = useState<boolean>(false);

  const preview = useMemo(() => {
    const yesTid = toBigIntStrict(pickedYesTokenId);
    const noTid = toBigIntStrict(pickedNoTokenId);
    if (yesTid === null || noTid === null) return null;

    const posTokenId = flipPolarity ? noTid : yesTid;
    const negTokenId = flipPolarity ? yesTid : noTid;

    return { yesTid, noTid, posTokenId, negTokenId };
  }, [pickedYesTokenId, pickedNoTokenId, flipPolarity]);

  const duplicateMarketReason = useMemo(() => {
    if (classMode !== "existing") return null;
    if (!selectedClassEntry) return null;

    const cond = (selectedMarket?.conditionId ?? "").trim().toLowerCase();
    const hasCond = isBytes32Hex(cond);

    const allAssets = [
      ...(selectedClassEntry.pos ?? []),
      ...(selectedClassEntry.neg ?? []),
    ];

    if (hasCond) {
      const alreadyHasCondition = allAssets.some(
        (a) => (a.conditionId ?? "").trim().toLowerCase() === cond,
      );
      if (alreadyHasCondition) {
        return "This market (conditionId) is already in the selected class.";
      }
    }

    const posTid = preview ? preview.posTokenId.toString() : "";
    const negTid = preview ? preview.negTokenId.toString() : "";
    if (posTid || negTid) {
      const tokenCollision = allAssets.some((a) => {
        const t = (a.tokenId ?? "").trim();
        return (posTid && t === posTid) || (negTid && t === negTid);
      });
      if (tokenCollision) {
        return "A tokenId you’re about to register already exists in the selected class.";
      }
    }

    return null;
  }, [classMode, selectedClassEntry, selectedMarket?.conditionId, preview]);

  // ---- midpoint ----
  const [yesMid, setYesMid] = useState<number | null>(null);
  const [noMid, setNoMid] = useState<number | null>(null);
  const [midError, setMidError] = useState<string>("");

  const midpointMismatchWarning = useMemo(() => {
    // Only relevant when registering into an existing class.
    if (classMode !== "existing") return null;
    if (!selectedClassEntry) return null;

    // Need live midpoints from the selected market
    if (yesMid == null || noMid == null) return null;

    // Need reference midpoints from the class
    const posMids = finiteMids(selectedClassEntry.pos ?? []);
    const negMids = finiteMids(selectedClassEntry.neg ?? []);

    const classPosRef = median(posMids);
    const classNegRef = median(negMids);
    if (classPosRef == null || classNegRef == null) return null;

    const selectedPosMid = toPctPoints(flipPolarity ? noMid : yesMid);
    const selectedNegMid = toPctPoints(flipPolarity ? yesMid : noMid);

    const classPosRefPct = toPctPoints(classPosRef);
    const classNegRefPct = toPctPoints(classNegRef);

    // Tolerance in percentage points (e.g. 2.0 = 2%)
    const EPS = 2.0;

    const dPos = Math.abs(selectedPosMid - classPosRefPct);
    const dNeg = Math.abs(selectedNegMid - classNegRefPct);

    if (dPos <= EPS && dNeg <= EPS) return null;

    const fmt = (x: number) => x.toFixed(4);

    const parts: string[] = [];
    if (dPos > EPS) {
      parts.push(
        `POS midpoint mismatch: selected ${fmt(selectedPosMid)} vs class median ${fmt(
          classPosRefPct,
        )} (Δ=${fmt(dPos)})`,
      );
    }
    if (dNeg > EPS) {
      parts.push(
        `NEG midpoint mismatch: selected ${fmt(selectedNegMid)} vs class median ${fmt(
          classNegRefPct,
        )} (Δ=${fmt(dNeg)})`,
      );
    }

    return parts.join(" | ");
  }, [classMode, selectedClassEntry, yesMid, noMid, flipPolarity]);

  // ---- staged NEG submit ----
  const [queuedNegArgs, setQueuedNegArgs] = useState<RegisterAssetArgs | null>(
    null,
  );

  const [pendingSecondTx, setPendingSecondTx] = useState<null | {
    posTxHash: `0x${string}`;
    args: RegisterAssetArgs;
  }>(null);

  const [waitingForPosTxHash, setWaitingForPosTxHash] = useState(false);

  const [localError, setLocalError] = useState<string>("");

  // ---- wagmi ----
  const {
    writeContract,
    data: txHash,
    error: writeError,
    isPending,
  } = useWriteContract();

  const {
    isLoading: isConfirming,
    isSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: Boolean(txHash) },
  });

  // ---- effects ----

  useEffect(() => {
    const normalized = normalizeTokenIdList(selectedMarket?.clobTokenIds);

    const t0 = isDecimalTokenId(selectedMarket?.yesTokenId)
      ? selectedMarket!.yesTokenId!.trim()
      : (normalized[0] ?? "");

    const t1 = isDecimalTokenId(selectedMarket?.noTokenId)
      ? selectedMarket!.noTokenId!.trim()
      : (normalized[1] ?? "");

    setPickedYesTokenId(t0);
    setPickedNoTokenId(t1);
    setFlipPolarity(false);
    setYesMid(null);
    setNoMid(null);
    setMidError("");
    setAssetIdPos(randomBytes32());
    setAssetIdNeg(randomBytes32());
  }, [selectedMarket]);

  useEffect(() => {
    const tid = pickedYesTokenId.trim();
    if (!/^\d+$/.test(tid)) {
      setYesMid(null);
      setNoMid(null);
      setMidError("");
      return;
    }

    const controller = new AbortController();

    (async () => {
      try {
        setMidError("");
        const res = await fetch(
          `/api/polymarket/midpoint?token_id=${encodeURIComponent(tid)}`,
          { cache: "no-store", signal: controller.signal },
        );

        const data = (await res.json()) as
          | { yesMid?: number | null; noMid?: number | null; error?: string }
          | any;

        if (!res.ok) {
          setYesMid(null);
          setNoMid(null);
          setMidError(data?.error ? String(data.error) : `midpoint failed`);
          return;
        }

        setYesMid(typeof data?.yesMid === "number" ? data.yesMid : null);
        setNoMid(typeof data?.noMid === "number" ? data.noMid : null);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setYesMid(null);
        setNoMid(null);
        setMidError("midpoint fetch failed");
      }
    })();

    return () => controller.abort();
  }, [pickedYesTokenId]);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        setExistingLoadError("");
        const res = await fetch("/api/correl/equiv-classes", {
          cache: "no-store",
          signal: controller.signal,
        });
        const json = (await res.json()) as any;

        const classes: ExistingClassEntry[] = Array.isArray(json?.classes)
          ? json.classes
              .map((c: any) => {
                const classId = typeof c?.classId === "string" ? c.classId : "";
                if (!isBytes32Hex(classId)) return null;

                const pos = Array.isArray(c?.pos)
                  ? (c.pos as ExistingAsset[])
                  : [];
                const neg = Array.isArray(c?.neg)
                  ? (c.neg as ExistingAsset[])
                  : [];

                return { classId, pos, neg } as ExistingClassEntry;
              })
              .filter((x: any) => x !== null)
          : [];

        setExistingClasses(classes);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setExistingClasses([]);
        setExistingLoadError("Failed to load existing classes");
      }
    })();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!waitingForPosTxHash) return;
    if (!queuedNegArgs) return;
    if (!txHash) return;

    setPendingSecondTx({ posTxHash: txHash, args: queuedNegArgs });
    setPosTxHashForFlow(txHash);

    setQueuedNegArgs(null);
    setWaitingForPosTxHash(false);
  }, [waitingForPosTxHash, queuedNegArgs, txHash]);

  useEffect(() => {
    if (!writeError) return;
    setRegisterPhase("idle");
    setWaitingForPosTxHash(false);
    setQueuedNegArgs(null);
    setPendingSecondTx(null);
    setPosTxHashForFlow(null);
  }, [writeError]);

  useEffect(() => {
    if (!pendingSecondTx) return;
    if (!isSuccess) return;
    if (txHash !== pendingSecondTx.posTxHash) return;

    setRegisterPhase("waitingNeg");

    writeContract({
      address: CORREL_ADDRESS,
      abi: CorrelAdminAbi,
      functionName: "registerAsset",
      args: pendingSecondTx.args,
    });

    setPendingSecondTx(null);
  }, [pendingSecondTx, isSuccess, txHash, writeContract]);

  // ---- derived ----

  const canRegisterPair = useMemo(() => {
    if (!isBytes32Hex(effectiveClassId.trim())) return false;
    if (!isBytes32Hex(assetIdPos)) return false;
    if (!isBytes32Hex(assetIdNeg)) return false;

    if (!isAddress(DEFAULT_CTF_ADDRESS)) return false;
    if (!isAddress(DEFAULT_COLLATERAL_ADDRESS)) return false;
    if (!isBytes32Hex(DEFAULT_PARENT_COLLECTION_ID)) return false;

    const yesTid = toBigIntStrict(pickedYesTokenId);
    const noTid = toBigIntStrict(pickedNoTokenId);
    if (yesTid === null || noTid === null) return false;

    const cond = selectedMarket?.conditionId?.trim() ?? "";
    if (!isBytes32Hex(cond)) return false;

    if (duplicateMarketReason) return false;

    return true;
  }, [
    effectiveClassId,
    assetIdPos,
    assetIdNeg,
    pickedYesTokenId,
    pickedNoTokenId,
    selectedMarket,
    duplicateMarketReason,
  ]);

  // ---- actions ----

  async function onRegisterPair() {
    setLocalError("");

    if (midpointMismatchWarning) {
      const msg =
        `Midpoint mismatch detected.\n\n` +
        `${midpointMismatchWarning}\n\n` +
        `Continue anyway?`;

      const ok = window.confirm(msg);
      if (!ok) return;
    }

    const classId = effectiveClassId.trim();
    const posId = assetIdPos.trim();
    const negId = assetIdNeg.trim();

    const token = DEFAULT_CTF_ADDRESS;
    const collateral = DEFAULT_COLLATERAL_ADDRESS;
    const parent = DEFAULT_PARENT_COLLECTION_ID;

    if (!isBytes32Hex(classId)) return setLocalError("classId must be bytes32");
    if (!isBytes32Hex(posId))
      return setLocalError("assetIdPos must be bytes32");
    if (!isBytes32Hex(negId))
      return setLocalError("assetIdNeg must be bytes32");

    if (!isAddress(token))
      return setLocalError("DEFAULT_CTF_ADDRESS is not set / invalid");
    if (!isAddress(collateral))
      return setLocalError("DEFAULT_COLLATERAL_ADDRESS is not set / invalid");
    if (!isBytes32Hex(parent))
      return setLocalError("DEFAULT_PARENT_COLLECTION_ID is invalid");

    const conditionId = (selectedMarket?.conditionId ?? "").trim();
    if (!isBytes32Hex(conditionId))
      return setLocalError("selectedMarket.conditionId must be bytes32");

    const yesTid = toBigIntStrict(pickedYesTokenId);
    const noTid = toBigIntStrict(pickedNoTokenId);
    if (yesTid === null || noTid === null)
      return setLocalError("TokenIds must be decimal uint256 strings");

    const iYes = DEFAULT_INDEXSET_YES;
    const iNo = DEFAULT_INDEXSET_NO;

    const posTokenId = flipPolarity ? noTid : yesTid;
    const negTokenId = flipPolarity ? yesTid : noTid;

    setRegisterPhase("waitingPos");

    writeContract({
      address: CORREL_ADDRESS,
      abi: CorrelAdminAbi,
      functionName: "registerAsset",
      args: [
        posId as `0x${string}`,
        token as `0x${string}`,
        posTokenId,
        classId as `0x${string}`,
        0,
        conditionId as `0x${string}`,
        (flipPolarity ? iNo : iYes)!,
        collateral as `0x${string}`,
        parent as `0x${string}`,
      ] as const,
    });

    const negArgs = [
      negId as `0x${string}`,
      token as `0x${string}`,
      negTokenId,
      classId as `0x${string}`,
      1,
      conditionId as `0x${string}`,
      (flipPolarity ? iYes : iNo)!,
      collateral as `0x${string}`,
      parent as `0x${string}`,
    ] as const;

    setPendingSecondTx(null);
    setQueuedNegArgs(negArgs);
    setWaitingForPosTxHash(true);
  }

  function consumeNegSuccessAndReset() {
    setRegisterPhase("idle");
    setPosTxHashForFlow(null);
  }

  return {
    // class selection state
    classMode,
    setClassMode,
    newClassId,
    setNewClassId,
    selectedExistingClassId,
    setSelectedExistingClassId,
    showExistingDropdown,
    setShowExistingDropdown,
    existingClasses,
    existingLoadError,
    effectiveClassId,
    selectedClassEntry,

    // market selection + mapping
    pickedYesTokenId,
    setPickedYesTokenId,
    pickedNoTokenId,
    setPickedNoTokenId,
    flipPolarity,
    setFlipPolarity,
    preview,

    // midpoint
    yesMid,
    noMid,
    midError,
    midpointMismatchWarning,

    // register workflow + errors
    registerPhase,
    posTxHashForFlow,
    canRegisterPair,
    duplicateMarketReason,
    localError,
    onRegisterPair,
    pendingSecondTx,

    // wagmi state exposed
    txHash: txHash ?? null,
    isPending,
    isConfirming,
    isSuccess,
    writeError: writeError ? { message: writeError.message } : null,
    receiptError: receiptError ? { message: receiptError.message } : null,

    // for panel redirect behavior
    setRegisterPhase,
    consumeNegSuccessAndReset,

    // utilities needed by UI
    randomBytes32,
    isBytes32Hex,
  };
}
