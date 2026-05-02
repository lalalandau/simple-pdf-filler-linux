import type { AppApi } from "../shared/types";

declare global {
  interface Window {
    pdfApp: AppApi;
  }
}

export {};

