import type { Overlay } from "./types.js";

const UNSUPPORTED_BASIC_LATIN = /[^\u0009\u000a\u000d\u0020-\u007e]/;

export function normalizeManualTextForExport(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...");
}

export function findUnsupportedManualText(overlays: Overlay[]): Extract<Overlay, { type: "text" }> | undefined {
  return overlays.find((overlay): overlay is Extract<Overlay, { type: "text" }> => {
    return overlay.type === "text" && UNSUPPORTED_BASIC_LATIN.test(normalizeManualTextForExport(overlay.text));
  });
}
