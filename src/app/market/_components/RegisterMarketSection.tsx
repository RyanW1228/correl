// src/app/market/_components/RegisterMarketSection.tsx

"use client";

import React from "react";

export function RegisterMarketSection(props: {
  pickedYesTokenId: string;
  setPickedYesTokenId: (v: string) => void;

  pickedNoTokenId: string;
  setPickedNoTokenId: (v: string) => void;

  flipPolarity: boolean;
  setFlipPolarity: (v: boolean) => void;

  preview: null | {
    posTokenId: bigint;
    negTokenId: bigint;
  };

  onRegisterPair: () => void;

  canRegisterPair: boolean;
  isPending: boolean;
  isConfirming: boolean;
  pendingSecondTx: unknown | null;

  duplicateMarketReason: string | null;
  midpointMismatchWarning: string | null;
  localError: string;

  writeError: { message: string } | null;
  receiptError: { message: string } | null;

  txHash: `0x${string}` | null;
  isSuccess: boolean;
}) {
  const {
    pickedYesTokenId,
    setPickedYesTokenId,
    pickedNoTokenId,
    setPickedNoTokenId,
    flipPolarity,
    setFlipPolarity,
    preview,
    onRegisterPair,
    canRegisterPair,
    isPending,
    isConfirming,
    pendingSecondTx,
    duplicateMarketReason,
    midpointMismatchWarning,
    localError,
    writeError,
    receiptError,
    txHash,
    isSuccess,
  } = props;

  return (
    <>
      <div style={{ padding: 12, border: "2px solid black", marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Register Market Into Class (POS + NEG)
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
                POS tokenId to register: {preview.posTokenId.toString()}{" "}
                <span style={{ color: "#555" }}>
                  (Market {flipPolarity ? "NO" : "YES"})
                </span>
              </div>
              <div>
                NEG tokenId to register: {preview.negTokenId.toString()}{" "}
                <span style={{ color: "#555" }}>
                  (Market {flipPolarity ? "YES" : "NO"})
                </span>
              </div>
            </>
          ) : (
            <div>(Pick two tokenIds to preview mapping)</div>
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

      {duplicateMarketReason && (
        <div style={{ color: "red", marginTop: 8 }}>
          {duplicateMarketReason}
        </div>
      )}

      {midpointMismatchWarning && (
        <div style={{ color: "red", marginTop: 8 }}>
          {midpointMismatchWarning}
        </div>
      )}

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
    </>
  );
}
