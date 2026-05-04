import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, ExportSnapshot, ExportResult, OpenedPdf } from "../shared/types.js";

const api: AppApi = {
  openPdf: () => ipcRenderer.invoke("pdf:open") as Promise<OpenedPdf | null>,
  exportPdf: (snapshot: ExportSnapshot, previousPath?: string) => ipcRenderer.invoke("pdf:export", snapshot, previousPath) as Promise<ExportResult | null>,
  openExternalFile: (filePath: string) => ipcRenderer.invoke("shell:openExternalFile", filePath) as Promise<void>,
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:showItemInFolder", filePath) as Promise<void>,
  setDirtyState: (dirty: boolean) => {
    ipcRenderer.send("app:setDirtyState", dirty);
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld("pdfApp", api);
