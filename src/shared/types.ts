export type Tool = "select" | "text" | "checkmark" | "oval";

export type OverlayType = "text" | "checkmark" | "oval";

export interface PageGeometry {
  pageIndex: number;
  width: number;
  height: number;
  rotation: number;
}

export interface TextOverlay {
  id: string;
  type: "text";
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
}

export interface CheckmarkOverlay {
  id: string;
  type: "checkmark";
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OvalOverlay {
  id: string;
  type: "oval";
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Overlay = TextOverlay | CheckmarkOverlay | OvalOverlay;

export type DetectedFieldType = "text" | "multiline" | "checkbox" | "radio" | "dropdown" | "unsupported";

export interface DetectedFieldWidget {
  id: string;
  fieldName: string;
  type: DetectedFieldType;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  options?: string[];
  exportValue?: string;
  required?: boolean;
}

export type FieldValue = string | boolean;

export interface ExportSnapshot {
  overlays: Overlay[];
  fieldValues: Record<string, FieldValue>;
  fields: DetectedFieldWidget[];
  pages: PageGeometry[];
}

export interface OpenedPdf {
  sessionId: string;
  fileName: string;
  filePath: string;
  size: number;
  bytes: ArrayBuffer;
}

export interface ExportResult {
  filePath: string;
}

export interface AppApi {
  openPdf(): Promise<OpenedPdf | null>;
  exportPdf(snapshot: ExportSnapshot, previousPath?: string): Promise<ExportResult | null>;
  openExternalFile(filePath: string): Promise<void>;
  showItemInFolder(filePath: string): Promise<void>;
  setDirtyState(dirty: boolean): void;
  platform: string;
}
