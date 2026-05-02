import type { PageGeometry } from "./types.js";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampRectToPage(rect: Rect, page: PageGeometry): Rect {
  const width = Math.min(Math.max(rect.width, 1), page.width);
  const height = Math.min(Math.max(rect.height, 1), page.height);
  return {
    x: Math.min(Math.max(rect.x, 0), page.width - width),
    y: Math.min(Math.max(rect.y, 0), page.height - height),
    width,
    height
  };
}

export function screenToPdfPoint(point: Point, pageRect: DOMRect, page: PageGeometry, scale: number): Point {
  return clampPointToPage(
    {
      x: (point.x - pageRect.left) / scale,
      y: (point.y - pageRect.top) / scale
    },
    page
  );
}

export function pdfRectToCss(rect: Rect, scale: number): Rect {
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale
  };
}

export function pdfRectToPdfLib(rect: Rect, page: PageGeometry): Rect {
  return {
    x: rect.x,
    y: page.height - rect.y - rect.height,
    width: rect.width,
    height: rect.height
  };
}

export function pdfPointToPdfLib(point: Point, page: PageGeometry): Point {
  return {
    x: point.x,
    y: page.height - point.y
  };
}

export function annotationRectToTopLeft(rect: number[], page: PageGeometry): Rect {
  const [x1, y1, x2, y2] = rect;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const bottom = Math.min(y1, y2);
  const top = Math.max(y1, y2);

  return {
    x: left,
    y: page.height - top,
    width: right - left,
    height: top - bottom
  };
}

export function clampPointToPage(point: Point, page: PageGeometry): Point {
  return {
    x: Math.min(Math.max(point.x, 0), page.width),
    y: Math.min(Math.max(point.y, 0), page.height)
  };
}

export function nudgeRect(rect: Rect, page: PageGeometry, dx: number, dy: number): Rect {
  return clampRectToPage(
    {
      ...rect,
      x: rect.x + dx,
      y: rect.y + dy
    },
    page
  );
}
