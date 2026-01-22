// src/app/market/_components/EquivalenceClassAdminPanel.tsx

"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  useEquivalenceClassAdmin,
  type SelectedMarket,
} from "./useEquivalenceClassAdmin";
import { ClassSelectionSection } from "./ClassSelectionSection";
import { RegisterMarketSection } from "./RegisterMarketSection";

type Props = {
  selectedMarket: SelectedMarket | null;
  prefillClassId?: string | null;
};

export function EquivalenceClassAdminPanel({
  selectedMarket,
  prefillClassId,
}: Props) {
  const router = useRouter();

  const s = useEquivalenceClassAdmin({ selectedMarket, prefillClassId });

  useEffect(() => {
    // Only redirect after the NEG tx is the one that confirmed.
    if (s.registerPhase !== "waitingNeg") return;
    if (!s.isSuccess) return;

    // Prevent redirecting on the POS confirmation.
    if (!s.txHash) return;
    if (s.posTxHashForFlow && s.txHash === s.posTxHashForFlow) return;

    const id = s.effectiveClassId.trim();
    if (!s.isBytes32Hex(id)) return;

    router.push(`/equiv-classes/${encodeURIComponent(id)}`);
    s.consumeNegSuccessAndReset();
  }, [
    s.registerPhase,
    s.isSuccess,
    s.txHash,
    s.posTxHashForFlow,
    s.effectiveClassId,
    s,
    router,
  ]);

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>
        Admin: Equivalence Class
      </div>

      {/* Selected market context section stays here for now (UI only).
          If you want, we can move it too, but it's already pretty bounded. */}
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
                  {s.pickedYesTokenId || "(missing)"}
                </div>
                <div style={{ marginLeft: 16, color: "#444" }}>
                  Midpoint:{" "}
                  {s.yesMid === null ? "(not loaded yet)" : s.yesMid.toString()}
                </div>

                <div style={{ marginTop: 8 }}>
                  <strong>Market NO tokenId:</strong>{" "}
                  {s.pickedNoTokenId || "(missing)"}
                </div>
                <div style={{ marginLeft: 16, color: "#444" }}>
                  Midpoint:{" "}
                  {s.noMid === null ? "(not loaded yet)" : s.noMid.toString()}
                </div>

                {s.midError && (
                  <div style={{ marginTop: 8, color: "red" }}>
                    Midpoint error: {s.midError}
                  </div>
                )}
              </div>

              <div style={{ marginTop: 10 }}>
                <label
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={s.flipPolarity}
                    onChange={(e) => s.setFlipPolarity(e.target.checked)}
                  />
                  Flip polarity (treat Market NO as Class YES)
                </label>
              </div>

              <div style={{ marginTop: 10, fontFamily: "monospace" }}>
                {s.preview ? (
                  <>
                    <div>
                      POS tokenId to register: {s.preview.posTokenId.toString()}{" "}
                      <span style={{ color: "#555" }}>
                        (Market {s.flipPolarity ? "NO" : "YES"})
                      </span>
                    </div>
                    <div>
                      NEG tokenId to register: {s.preview.negTokenId.toString()}{" "}
                      <span style={{ color: "#555" }}>
                        (Market {s.flipPolarity ? "YES" : "NO"})
                      </span>
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
          </>
        )}
      </div>

      <ClassSelectionSection
        classMode={s.classMode}
        setClassMode={s.setClassMode}
        existingLoadError={s.existingLoadError}
        existingClasses={s.existingClasses}
        showExistingDropdown={s.showExistingDropdown}
        setShowExistingDropdown={s.setShowExistingDropdown}
        selectedExistingClassId={s.selectedExistingClassId}
        setSelectedExistingClassId={s.setSelectedExistingClassId}
        effectiveClassId={s.effectiveClassId}
        randomBytes32={s.randomBytes32}
        setNewClassId={s.setNewClassId}
        selectedClassEntry={s.selectedClassEntry}
      />

      <RegisterMarketSection
        pickedYesTokenId={s.pickedYesTokenId}
        setPickedYesTokenId={s.setPickedYesTokenId}
        pickedNoTokenId={s.pickedNoTokenId}
        setPickedNoTokenId={s.setPickedNoTokenId}
        flipPolarity={s.flipPolarity}
        setFlipPolarity={s.setFlipPolarity}
        preview={
          s.preview
            ? {
                posTokenId: s.preview.posTokenId,
                negTokenId: s.preview.negTokenId,
              }
            : null
        }
        onRegisterPair={s.onRegisterPair}
        canRegisterPair={s.canRegisterPair}
        isPending={s.isPending}
        isConfirming={s.isConfirming}
        pendingSecondTx={s.pendingSecondTx}
        duplicateMarketReason={s.duplicateMarketReason}
        midpointMismatchWarning={s.midpointMismatchWarning}
        localError={s.localError}
        writeError={s.writeError}
        receiptError={s.receiptError}
        txHash={s.txHash}
        isSuccess={s.isSuccess}
      />
    </div>
  );
}
