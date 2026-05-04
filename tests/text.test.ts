import { describe, expect, it } from "vitest";
import { findUnsupportedManualText, normalizeManualTextForExport } from "../src/shared/text";
import type { Overlay } from "../src/shared/types";

describe("manual text export normalization", () => {
  it("normalizes contentEditable whitespace and common English punctuation", () => {
    expect(normalizeManualTextForExport("Jane\u00a0Doe\u200b\u2019s form\u2014done\u2026")).toBe("Jane Doe's form-done...");
  });

  it("does not reject normalized English text", () => {
    const overlays: Overlay[] = [
      {
        id: "text-1",
        type: "text",
        pageIndex: 0,
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        text: "Hello\u00a0world",
        fontSize: 11
      }
    ];

    expect(findUnsupportedManualText(overlays)).toBeUndefined();
  });
});

