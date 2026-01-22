// src/app/market/_components/EquivalenceClassAdminPanel.tsx

"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useWriteContract } from "wagmi";
import { useWaitForTransactionReceipt } from "wagmi";

const CORREL_ADDRESS = "0xd55963Bd90b14a2fE151C54788e58Ee84AA1F6dC" as const;

// ---- Defaults for "Register Market Into Class" autofill ----
// You can change these once and every selected market will prefill.
// (These are admin-side UX defaults; they don't come from Polymarket.)

// ---- Defaults for "Register Market Into Class" (hidden, always-on) ----
// IMPORTANT: Fill these two with YOUR actual addresses (no guessing here).
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

function isBytes32Hex(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

function isAddress(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isDecimalTokenId(raw: string | undefined): raw is string {
  if (!raw) return false;
  const t = raw.trim();
  // tokenIds in your UI are decimal strings (not JSON arrays)
  return /^\d+$/.test(t);
}

function toBigIntStrict(label: string, raw: string): bigint | null {
  const t = raw.trim();
  if (!t) return null;
  // allow decimal only (keep it simple)
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

    // Case: item is actually a JSON-encoded array like '["123","456"]'
    if (t.startsWith("[") && t.endsWith("]")) {
      try {
        const arr = JSON.parse(t) as unknown;
        if (Array.isArray(arr)) {
          for (const v of arr) {
            if (typeof v === "string" && v.trim()) out.push(v.trim());
          }
          continue;
        }
      } catch {
        // fall through
      }
    }

    // Normal case: item is a tokenId string
    if (t) out.push(t);
  }

  // de-dupe while preserving order
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

type SelectedMarket = {
  title: string;
  slug?: string;

  // on-chain settlement metadata you already store in contract
  conditionId?: string; // bytes32

  // token ids for the two legs (if you have them); otherwise you’ll pick from clobTokenIds manually
  yesTokenId?: string; // uint256 as string
  noTokenId?: string; // uint256 as string
  clobTokenIds?: string[]; // fallback list for dropdown
};

type Props = {
  selectedMarket: SelectedMarket | null;
  prefillClassId?: string | null;
};

export function EquivalenceClassAdminPanel({
  selectedMarket,
  prefillClassId,
}: Props) {
  // Admin UI state
  type ClassMode = "new" | "existing";

  const [classMode, setClassMode] = useState<ClassMode>("new");

  // Always have a “new class” id ready (used when classMode === "new")
  const [newClassId, setNewClassId] = useState<string>(randomBytes32());

  // Used when classMode === "existing"
  const [selectedExistingClassId, setSelectedExistingClassId] =
    useState<string>("");

  // UI: show/hide dropdown
  const [showExistingDropdown, setShowExistingDropdown] = useState(false);

  // Loaded from /api/correl/equiv-classes
  const [existingClassIds, setExistingClassIds] = useState<string[]>([]);
  const [existingLoadError, setExistingLoadError] = useState<string>("");

  useEffect(() => {
    const v = (prefillClassId ?? "").trim();
    if (!v) return;
    if (!isBytes32Hex(v)) return;

    setClassMode("existing");
    setSelectedExistingClassId(v);
    setShowExistingDropdown(false);
  }, [prefillClassId]);

  const [localError, setLocalError] = useState<string>("");

  const effectiveClassId = useMemo(() => {
    return classMode === "new" ? newClassId : selectedExistingClassId;
  }, [classMode, newClassId, selectedExistingClassId]);

  // you told me not to guess your assetId scheme, so we input both explicitly
  const [assetIdPos, setAssetIdPos] = useState<string>(""); // bytes32
  const [assetIdNeg, setAssetIdNeg] = useState<string>(""); // bytes32

  // pick which token is market YES/NO, then optional flip mapping into POS/NEG
  const [pickedYesTokenId, setPickedYesTokenId] = useState<string>("");
  const [pickedNoTokenId, setPickedNoTokenId] = useState<string>("");
  const [flipPolarity, setFlipPolarity] = useState<boolean>(false);

  // Midpoint display (YES fetched, NO is complement from route)
  const [yesMid, setYesMid] = useState<number | null>(null);
  const [noMid, setNoMid] = useState<number | null>(null);
  const [midError, setMidError] = useState<string>("");

  type RegisterAssetArgs = readonly [
    `0x${string}`, // assetId
    `0x${string}`, // token (IERC1155)
    bigint, // tokenId
    `0x${string}`, // classId
    0 | 1, // polarity
    `0x${string}`, // conditionId
    bigint, // indexSet
    `0x${string}`, // collateralToken
    `0x${string}`, // parentCollectionId
  ];

  // One-click flow: stage NEG args, then bind to POS txHash, then submit after POS confirms
  const [queuedNegArgs, setQueuedNegArgs] = useState<RegisterAssetArgs | null>(
    null,
  );

  const [pendingSecondTx, setPendingSecondTx] = useState<null | {
    posTxHash: `0x${string}`;
    args: RegisterAssetArgs;
  }>(null);

  // WAGMI tx state
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

  const [waitingForPosTxHash, setWaitingForPosTxHash] = useState(false);

  useEffect(() => {
    // Bind queued NEG args to the POS txHash that was just created from this click.
    if (!waitingForPosTxHash) return;
    if (!queuedNegArgs) return;
    if (!txHash) return;

    setPendingSecondTx({
      posTxHash: txHash,
      args: queuedNegArgs,
    });

    setQueuedNegArgs(null);
    setWaitingForPosTxHash(false);
  }, [waitingForPosTxHash, queuedNegArgs, txHash]);

  useEffect(() => {
    if (writeError) {
      setWaitingForPosTxHash(false);
      setQueuedNegArgs(null);
      setPendingSecondTx(null);
    }
  }, [writeError]);

  const canRegisterPair = useMemo(() => {
    if (!isBytes32Hex(effectiveClassId.trim())) return false;
    if (!isBytes32Hex(assetIdPos.trim())) return false;
    if (!isBytes32Hex(assetIdNeg.trim())) return false;

    // hidden constants (must be set)
    if (!isAddress(DEFAULT_CTF_ADDRESS)) return false;
    if (!isAddress(DEFAULT_COLLATERAL_ADDRESS)) return false;
    if (!isBytes32Hex(DEFAULT_PARENT_COLLECTION_ID)) return false;

    const yesTid = toBigIntStrict("yesTokenId", pickedYesTokenId);
    const noTid = toBigIntStrict("noTokenId", pickedNoTokenId);
    if (yesTid === null || noTid === null) return false;

    const cond = selectedMarket?.conditionId?.trim() ?? "";
    if (!isBytes32Hex(cond)) return false;

    return true;
  }, [
    effectiveClassId,
    assetIdPos,
    assetIdNeg,
    pickedYesTokenId,
    pickedNoTokenId,
    selectedMarket,
  ]);

  const preview = useMemo(() => {
    const yesTid = toBigIntStrict("yesTokenId", pickedYesTokenId);
    const noTid = toBigIntStrict("noTokenId", pickedNoTokenId);
    if (yesTid === null || noTid === null) return null;

    const posTokenId = flipPolarity ? noTid : yesTid;
    const negTokenId = flipPolarity ? yesTid : noTid;

    return { yesTid, noTid, posTokenId, negTokenId };
  }, [pickedYesTokenId, pickedNoTokenId, flipPolarity]);

  useEffect(() => {
    const normalized = normalizeTokenIdList(selectedMarket?.clobTokenIds);

    // Only trust yesTokenId/noTokenId if they are single decimal tokenIds.
    // (Your current bug is yesTokenId sometimes being the JSON array string.)
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

    // If assetIds aren't set yet, generate them on market select (one-time).
    // (Does NOT overwrite if you already typed/pasted valid bytes32s.)
    if (!isBytes32Hex(assetIdPos.trim())) setAssetIdPos(randomBytes32());
    if (!isBytes32Hex(assetIdNeg.trim())) setAssetIdNeg(randomBytes32());
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

        setYesMid(
          typeof data?.yesMid === "number"
            ? data.yesMid
            : (data?.yesMid ?? null),
        );
        setNoMid(
          typeof data?.noMid === "number" ? data.noMid : (data?.noMid ?? null),
        );
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
    // If we have a queued NEG tx and POS is confirmed, submit NEG exactly once.
    if (!pendingSecondTx) return;
    if (!isSuccess) return;
    if (txHash !== pendingSecondTx.posTxHash) return;

    writeContract({
      address: CORREL_ADDRESS,
      abi: CorrelAdminAbi,
      functionName: "registerAsset",
      args: pendingSecondTx.args,
    });

    // clear queue so we don't resend on re-renders
    setPendingSecondTx(null);
  }, [pendingSecondTx, isSuccess, txHash, writeContract]);

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

        const ids = Array.isArray(json?.classes)
          ? json.classes
              .map((c: any) =>
                typeof c?.classId === "string" ? c.classId : "",
              )
              .filter((x: string) => isBytes32Hex(x))
          : [];

        // de-dupe, preserve order
        setExistingClassIds(Array.from(new Set(ids)));
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setExistingClassIds([]);
        setExistingLoadError("Failed to load existing classes");
      }
    })();

    return () => controller.abort();
  }, []);

  async function onRegisterPair() {
    setLocalError("");

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

    const yesTid = toBigIntStrict("yesTokenId", pickedYesTokenId);
    const noTid = toBigIntStrict("noTokenId", pickedNoTokenId);
    if (yesTid === null || noTid === null)
      return setLocalError("TokenIds must be decimal uint256 strings");

    // Fixed indexSets for Polymarket binary conditions.
    const iYes = DEFAULT_INDEXSET_YES;
    const iNo = DEFAULT_INDEXSET_NO;

    const posTokenId = flipPolarity ? noTid : yesTid;
    const negTokenId = flipPolarity ? yesTid : noTid;

    // ... keep your writeContract(...) and negArgs logic exactly as you already have it

    // Two txs: register POS then register NEG (v0; no multicall in your contract)
    // POS = 0, NEG = 1
    // Submit POS first
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

    // Queue NEG to auto-submit after POS confirms.
    // We store args now so UI changes while waiting don't alter what gets sent.
    //
    // NOTE: txHash is still from the *previous* write at this moment.
    // We'll attach the queue once we see the new txHash in the next effect.
    //
    // So we stage the args only; we bind it to the POS txHash in the next effect below.
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

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>
        Admin: Equivalence Class
      </div>

      {/* Selected market context (this is the “wire selectedMarket into admin” part) */}
      <div style={{ padding: 12, border: "2px solid black", marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Selected Market (Will Be Added To A Class)
        </div>

        {!selectedMarket && (
          <div style={{ marginTop: 6 }}>(No market selected yet)</div>
        )}

        {selectedMarket && (
          <>
            <div style={{ fontWeight: 600 }}>{selectedMarket.title}</div>

            <div
              style={{ marginTop: 12, padding: 10, border: "1px solid #000" }}
            >
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                Market → Class Mapping (Default + Optional Flip)
              </div>

              <div style={{ fontFamily: "monospace", marginTop: 6 }}>
                <div>
                  <strong>Market YES tokenId:</strong>{" "}
                  {pickedYesTokenId || "(missing)"}
                </div>
                <div style={{ marginLeft: 16, color: "#444" }}>
                  Midpoint:{" "}
                  {yesMid === null ? "(not loaded yet)" : yesMid.toString()}
                </div>

                <div style={{ marginTop: 8 }}>
                  <strong>Market NO tokenId:</strong>{" "}
                  {pickedNoTokenId || "(missing)"}
                </div>
                <div style={{ marginLeft: 16, color: "#444" }}>
                  Midpoint:{" "}
                  {noMid === null ? "(not loaded yet)" : noMid.toString()}
                </div>

                {midError && (
                  <div style={{ marginTop: 8, color: "red" }}>
                    Midpoint error: {midError}
                  </div>
                )}
              </div>

              <div style={{ marginTop: 10 }}>
                <label
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={flipPolarity}
                    onChange={(e) => setFlipPolarity(e.target.checked)}
                  />
                  Flip polarity (treat Market NO as Class YES)
                </label>
              </div>

              <div style={{ marginTop: 10, fontFamily: "monospace" }}>
                {preview ? (
                  <>
                    <div>
                      POS tokenId to register: {preview.posTokenId.toString()}
                    </div>
                    <div>
                      NEG tokenId to register: {preview.negTokenId.toString()}
                    </div>
                  </>
                ) : (
                  <div>(Pick two tokenIds to preview mapping)</div>
                )}
              </div>
            </div>

            <div style={{ fontFamily: "monospace", marginTop: 6 }}>
              slug: {selectedMarket.slug ?? "(missing)"}
            </div>
            <div style={{ fontFamily: "monospace" }}>
              conditionId: {selectedMarket.conditionId ?? "(missing)"}
            </div>
            <div style={{ fontFamily: "monospace" }}>
              clobTokenIds:{" "}
              {selectedMarket.clobTokenIds?.join(", ") ?? "(missing)"}
            </div>

            {/* Placeholder so you stay focused on the goal */}
            <div style={{ marginTop: 10, fontStyle: "italic" }}>
              Next: we’ll wire the contract call that adds this selected market
              into an existing class (needs your contract function signature).
            </div>
          </>
        )}
      </div>

      {/* Class selection (no manual entry) */}
      <div style={{ padding: 12, border: "2px solid black", marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Class Selection</div>

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setClassMode("new");
              setShowExistingDropdown(false);
              // refresh “new class” id so it’s always clearly a new class action
              setNewClassId(randomBytes32());
            }}
            disabled={classMode === "new"}
          >
            Create New Class
          </button>

          <button
            type="button"
            onClick={() => {
              setClassMode("existing");
              setShowExistingDropdown(true);
            }}
            disabled={classMode === "existing"}
          >
            Choose From Existing Classes
          </button>
        </div>

        {classMode === "existing" && (
          <div style={{ fontSize: 12 }}>
            {existingLoadError && (
              <div style={{ color: "red", marginBottom: 8 }}>
                {existingLoadError}
              </div>
            )}

            {showExistingDropdown && (
              <>
                <div style={{ marginBottom: 6 }}>Pick an existing classId:</div>
                <select
                  value={selectedExistingClassId}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSelectedExistingClassId(v);
                    if (v) setShowExistingDropdown(false);
                  }}
                  style={{
                    width: 520,
                    maxWidth: "100%",
                    fontFamily: "monospace",
                  }}
                >
                  <option value="">(select)</option>
                  {existingClassIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        )}

        <div style={{ marginTop: 8, fontSize: 12 }}>
          ClassId:{" "}
          <span style={{ fontFamily: "monospace" }}>
            {effectiveClassId || "(not selected)"}
          </span>
        </div>
      </div>

      <div style={{ padding: 12, border: "2px solid black", marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Register Market Into Class (POS + NEG)
        </div>

        <div
          style={{ marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <button
            type="button"
            onClick={() => {
              setAssetIdPos(randomBytes32());
              setAssetIdNeg(randomBytes32());
            }}
          >
            Generate random asset IDs
          </button>
        </div>

        <div style={{ marginBottom: 8 }}>
          <div>assetId for POS leg (bytes32):</div>
          <input
            value={assetIdPos}
            onChange={(e) => setAssetIdPos(e.target.value)}
            placeholder="0x + 64 hex chars"
            style={{ width: 520, maxWidth: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <div>assetId for NEG leg (bytes32):</div>
          <input
            value={assetIdNeg}
            onChange={(e) => setAssetIdNeg(e.target.value)}
            placeholder="0x + 64 hex chars"
            style={{ width: 520, maxWidth: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <div>Market YES tokenId (uint256 decimal):</div>
          <input
            value={pickedYesTokenId}
            onChange={(e) => setPickedYesTokenId(e.target.value)}
            placeholder="e.g. 123456..."
            style={{ width: 520, maxWidth: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <div>Market NO tokenId (uint256 decimal):</div>
          <input
            value={pickedNoTokenId}
            onChange={(e) => setPickedNoTokenId(e.target.value)}
            placeholder="e.g. 123457..."
            style={{ width: 520, maxWidth: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={flipPolarity}
              onChange={(e) => setFlipPolarity(e.target.checked)}
            />
            Flip polarity (Market NO becomes POS)
          </label>
        </div>

        <div style={{ fontFamily: "monospace" }}>
          {preview ? (
            <>
              <div>
                POS tokenId to register: {preview.posTokenId.toString()}
              </div>
              <div>
                NEG tokenId to register: {preview.negTokenId.toString()}
              </div>
              <div>
                Using indexSets (fixed): YES={DEFAULT_INDEXSET_YES.toString()}{" "}
                NO=
                {DEFAULT_INDEXSET_NO.toString()}
              </div>
            </>
          ) : (
            <div>(Enter YES/NO tokenIds to preview)</div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onRegisterPair}
        disabled={!canRegisterPair || isPending || isConfirming}
      >
        {isPending
          ? "Submitting..."
          : isConfirming
            ? "Confirming..."
            : pendingSecondTx
              ? "Confirming POS... then auto-registering NEG"
              : "Register POS + NEG (one click)"}
      </button>

      {localError && <div style={{ color: "red" }}>{localError}</div>}
      {writeError && (
        <div style={{ color: "red" }}>Error: {writeError.message}</div>
      )}
      {receiptError && (
        <div style={{ color: "red" }}>Error: {receiptError.message}</div>
      )}

      {txHash && (
        <div style={{ marginTop: 8 }}>
          tx: <span style={{ fontFamily: "monospace" }}>{txHash}</span>
        </div>
      )}
      {isSuccess && <div style={{ marginTop: 8 }}>Success.</div>}
    </div>
  );
}
