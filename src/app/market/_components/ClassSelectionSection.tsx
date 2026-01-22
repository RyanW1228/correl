// src/app/market/_components/ClassSelectionSection.tsx

"use client";

import React from "react";
import type { ExistingClassEntry } from "./useEquivalenceClassAdmin";

export function ClassSelectionSection(props: {
  classMode: "new" | "existing";
  setClassMode: (v: "new" | "existing") => void;

  existingLoadError: string;
  existingClasses: ExistingClassEntry[];

  showExistingDropdown: boolean;
  setShowExistingDropdown: (v: boolean) => void;

  selectedExistingClassId: string;
  setSelectedExistingClassId: (v: string) => void;

  effectiveClassId: string;

  randomBytes32: () => `0x${string}`;
  setNewClassId: (v: string) => void;

  selectedClassEntry: ExistingClassEntry | null;
}) {
  const {
    classMode,
    setClassMode,
    existingLoadError,
    existingClasses,
    showExistingDropdown,
    setShowExistingDropdown,
    selectedExistingClassId,
    setSelectedExistingClassId,
    effectiveClassId,
    randomBytes32,
    setNewClassId,
    selectedClassEntry,
  } = props;

  return (
    <div style={{ padding: 12, border: "2px solid black", marginBottom: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Class Selection</div>

      <div
        style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}
      >
        <button
          type="button"
          onClick={() => {
            setClassMode("new");
            setShowExistingDropdown(false);
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
                {existingClasses.map((c) => (
                  <option key={c.classId} value={c.classId}>
                    {c.classId}
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

      {classMode === "existing" && effectiveClassId && (
        <div style={{ marginTop: 12 }}>
          {!selectedClassEntry ? (
            <div style={{ fontSize: 12 }}>
              (No class data loaded for this classId.)
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}
            >
              <thead>
                <tr>
                  <th align="left">Market</th>
                  <th align="left">Side</th>
                  <th align="left">Midpoint</th>
                  <th align="left">conditionId</th>
                  <th align="left">tokenId</th>
                  <th align="left">Link</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={6} style={{ paddingTop: 10, fontWeight: 600 }}>
                    POS
                  </td>
                </tr>
                {(selectedClassEntry.pos ?? []).map((m) => (
                  <tr key={m.assetId}>
                    <td>{m.title ?? "(no title)"}</td>
                    <td>{m.side}</td>
                    <td>{m.midpoint == null ? "—" : m.midpoint.toFixed(4)}</td>
                    <td style={{ fontFamily: "monospace" }}>
                      {m.conditionId.slice(0, 10)}…{m.conditionId.slice(-8)}
                    </td>
                    <td style={{ fontFamily: "monospace" }}>
                      {m.tokenId.slice(0, 10)}…{m.tokenId.slice(-8)}
                    </td>
                    <td>
                      {m.polymarketUrl ? (
                        <a
                          href={m.polymarketUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}

                <tr>
                  <td colSpan={6} style={{ paddingTop: 10, fontWeight: 600 }}>
                    NEG
                  </td>
                </tr>
                {(selectedClassEntry.neg ?? []).map((m) => (
                  <tr key={m.assetId}>
                    <td>{m.title ?? "(no title)"}</td>
                    <td>{m.side}</td>
                    <td>{m.midpoint == null ? "—" : m.midpoint.toFixed(4)}</td>
                    <td style={{ fontFamily: "monospace" }}>
                      {m.conditionId.slice(0, 10)}…{m.conditionId.slice(-8)}
                    </td>
                    <td style={{ fontFamily: "monospace" }}>
                      {m.tokenId.slice(0, 10)}…{m.tokenId.slice(-8)}
                    </td>
                    <td>
                      {m.polymarketUrl ? (
                        <a
                          href={m.polymarketUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
