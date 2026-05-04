import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import isDev from "electron-is-dev";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { DetectedFieldWidget, ExportSnapshot, FieldValue, OpenedPdf, PageGeometry } from "../shared/types.js";
import { pdfRectToPdfLib } from "../shared/coordinates.js";
import { findUnsupportedManualText, normalizeManualTextForExport } from "../shared/text.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PdfSession {
  id: string;
  filePath: string;
  fileName: string;
  bytes: Uint8Array;
}

let mainWindow: BrowserWindow | null = null;
let currentSession: PdfSession | null = null;
let hasUnsavedEdits = false;
let closeConfirmed = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    title: "Simple PDF Filler",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    void mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", async (event) => {
    if (!hasUnsavedEdits || closeConfirmed) {
      return;
    }

    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      buttons: ["Discard edits and close", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Discard current edits?",
      detail: "You have unsaved PDF edits that have not been exported."
    });

    if (result.response === 0) {
      closeConfirmed = true;
      mainWindow?.close();
    }
  });
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function openPdfFromPath(filePath: string): Promise<OpenedPdf> {
  const bytes = await readFile(filePath);
  const session: PdfSession = {
    id: crypto.randomUUID(),
    filePath,
    fileName: path.basename(filePath),
    bytes
  };
  currentSession = session;
  return {
    sessionId: session.id,
    fileName: session.fileName,
    filePath: session.filePath,
    size: bytes.byteLength,
    bytes: bytesToArrayBuffer(bytes)
  };
}

function suggestedExportPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}-filled.pdf`);
}

async function resolveExportPath(previousPath?: string): Promise<string | null> {
  if (previousPath) {
    const response = await dialog.showMessageBox(mainWindow!, {
      type: "question",
      buttons: ["Replace", "Choose Different File", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: "Replace previous export?",
      detail: previousPath
    });

    if (response.response === 0) {
      return previousPath;
    }

    if (response.response === 2) {
      return null;
    }
  }

  const result = await dialog.showSaveDialog(mainWindow!, {
    title: "Export Filled PDF",
    defaultPath: currentSession ? suggestedExportPath(currentSession.filePath) : "filled.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });

  return result.canceled || !result.filePath ? null : result.filePath;
}

function assertBasicLatin(snapshot: ExportSnapshot) {
  const invalid = findUnsupportedManualText(snapshot.overlays);
  if (invalid) {
    throw new Error(`Manual text on page ${invalid.pageIndex + 1} contains characters unsupported by the MVP export font.`);
  }
}

async function exportPdf(snapshot: ExportSnapshot, previousPath?: string) {
  if (!currentSession) {
    throw new Error("No PDF is open.");
  }

  assertBasicLatin(snapshot);
  const outputPath = await resolveExportPath(previousPath);
  if (!outputPath) {
    return null;
  }

  const pdfDoc = await PDFDocument.load(currentSession.bytes, { ignoreEncryption: false });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  drawDetectedFieldValues(pdfDoc, snapshot, font);
  try {
    pdfDoc.getForm().flatten();
  } catch {
    // Some PDFs have malformed AcroForm data. Manual widget values have already been drawn.
  }

  for (const overlay of snapshot.overlays) {
    const page = pages[overlay.pageIndex];
    const pageGeometry = snapshot.pages[overlay.pageIndex];
    if (!page || !pageGeometry) {
      continue;
    }

    if (overlay.type === "text" && overlay.text.trim()) {
      const pdfRect = pdfRectToPdfLib(overlay, pageGeometry);
      page.drawText(normalizeManualTextForExport(overlay.text), {
        x: pdfRect.x,
        y: pdfRect.y + Math.max(2, overlay.height - overlay.fontSize),
        size: overlay.fontSize,
        font,
        color: rgb(0, 0, 0)
      });
    }

    if (overlay.type === "checkmark") {
      const pdfRect = pdfRectToPdfLib(overlay, pageGeometry);
      const strokeWidth = Math.max(1, Math.min(pdfRect.width, pdfRect.height) * 0.12);
      page.drawLine({
        start: { x: pdfRect.x + pdfRect.width * 0.12, y: pdfRect.y + pdfRect.height * 0.48 },
        end: { x: pdfRect.x + pdfRect.width * 0.4, y: pdfRect.y + pdfRect.height * 0.18 },
        thickness: strokeWidth,
        color: rgb(0, 0, 0)
      });
      page.drawLine({
        start: { x: pdfRect.x + pdfRect.width * 0.4, y: pdfRect.y + pdfRect.height * 0.18 },
        end: { x: pdfRect.x + pdfRect.width * 0.9, y: pdfRect.y + pdfRect.height * 0.86 },
        thickness: strokeWidth,
        color: rgb(0, 0, 0)
      });
    }

    if (overlay.type === "oval") {
      const pdfRect = pdfRectToPdfLib(overlay, pageGeometry);
      page.drawEllipse({
        x: pdfRect.x + pdfRect.width / 2,
        y: pdfRect.y + pdfRect.height / 2,
        xScale: pdfRect.width / 2,
        yScale: pdfRect.height / 2,
        borderWidth: Math.max(1, Math.min(pdfRect.width, pdfRect.height) * 0.08),
        borderColor: rgb(0, 0, 0)
      });
    }
  }

  await writeFile(outputPath, await pdfDoc.save());
  return { filePath: outputPath };
}

function drawDetectedFieldValues(pdfDoc: PDFDocument, snapshot: ExportSnapshot, font: Awaited<ReturnType<PDFDocument["embedFont"]>>) {
  const pages = pdfDoc.getPages();
  for (const field of snapshot.fields) {
    const value = snapshot.fieldValues[field.id];
    const page = pages[field.pageIndex];
    const pageGeometry = snapshot.pages[field.pageIndex];
    if (!page || !pageGeometry || value === undefined || value === false || value === "") {
      continue;
    }

    drawDetectedFieldValue(page, pageGeometry, field, value, font);
  }
}

function drawDetectedFieldValue(
  page: ReturnType<PDFDocument["getPages"]>[number],
  pageGeometry: PageGeometry,
  field: DetectedFieldWidget,
  value: FieldValue,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>
) {
  const pdfRect = pdfRectToPdfLib(field, pageGeometry);
  if (typeof value === "boolean") {
    const strokeWidth = Math.max(1, Math.min(pdfRect.width, pdfRect.height) * 0.12);
    page.drawLine({
      start: { x: pdfRect.x + pdfRect.width * 0.12, y: pdfRect.y + pdfRect.height * 0.48 },
      end: { x: pdfRect.x + pdfRect.width * 0.4, y: pdfRect.y + pdfRect.height * 0.18 },
      thickness: strokeWidth,
      color: rgb(0, 0, 0)
    });
    page.drawLine({
      start: { x: pdfRect.x + pdfRect.width * 0.4, y: pdfRect.y + pdfRect.height * 0.18 },
      end: { x: pdfRect.x + pdfRect.width * 0.9, y: pdfRect.y + pdfRect.height * 0.86 },
      thickness: strokeWidth,
      color: rgb(0, 0, 0)
    });
    return;
  }

  const text = normalizeManualTextForExport(value);
  const fontSize = Math.max(6, Math.min(12, pdfRect.height * 0.7));
  page.drawText(text, {
    x: pdfRect.x + 2,
    y: pdfRect.y + Math.max(2, (pdfRect.height - fontSize) / 2),
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
    maxWidth: Math.max(1, pdfRect.width - 4)
  });
}

app.whenReady().then(() => {
  ipcMain.handle("pdf:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Open PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return openPdfFromPath(result.filePaths[0]);
  });

  ipcMain.handle("pdf:export", async (_event, snapshot: ExportSnapshot, previousPath?: string) => exportPdf(snapshot, previousPath));
  ipcMain.handle("shell:openExternalFile", async (_event, filePath: string) => {
    await shell.openPath(filePath);
  });
  ipcMain.handle("shell:showItemInFolder", (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });
  ipcMain.on("app:setDirtyState", (_event, dirty: boolean) => {
    hasUnsavedEdits = dirty;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
