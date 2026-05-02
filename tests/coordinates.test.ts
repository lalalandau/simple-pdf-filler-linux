import { describe, expect, it } from "vitest";
import { annotationRectToTopLeft, clampRectToPage, pdfRectToPdfLib } from "../src/shared/coordinates";
import type { PageGeometry } from "../src/shared/types";

const page: PageGeometry = {
  pageIndex: 0,
  width: 612,
  height: 792,
  rotation: 0
};

describe("coordinate helpers", () => {
  it("converts top-left app rects to pdf-lib bottom-left rects", () => {
    expect(pdfRectToPdfLib({ x: 72, y: 100, width: 200, height: 24 }, page)).toEqual({
      x: 72,
      y: 668,
      width: 200,
      height: 24
    });
  });

  it("converts PDF annotation rects into top-left app rects", () => {
    expect(annotationRectToTopLeft([72, 668, 272, 692], page)).toEqual({
      x: 72,
      y: 100,
      width: 200,
      height: 24
    });
  });

  it("clamps overlays inside page bounds", () => {
    expect(clampRectToPage({ x: 600, y: -20, width: 40, height: 20 }, page)).toEqual({
      x: 572,
      y: 0,
      width: 40,
      height: 20
    });
  });
});

