import { useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { annotationRectToTopLeft, clampRectToPage, nudgeRect, pdfRectToCss, screenToPdfPoint } from "../shared/coordinates";
import { findUnsupportedManualText, normalizeManualTextForExport } from "../shared/text";
import type { DetectedFieldType, DetectedFieldWidget, ExportSnapshot, FieldValue, OpenedPdf, Overlay, PageGeometry, Tool } from "../shared/types";
import "./styles.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface ContentState {
  overlays: Overlay[];
  fieldValues: Record<string, FieldValue>;
}

interface EditorState extends ContentState {
  selectedId: string | null;
  editingId: string | null;
  tool: Tool;
  defaultFontSize: number;
  showFields: boolean;
}

interface HistoryState {
  present: EditorState;
  past: ContentState[];
  future: ContentState[];
}

type Action =
  | { type: "reset" }
  | { type: "setTool"; tool: Tool }
  | { type: "setShowFields"; show: boolean }
  | { type: "select"; id: string | null }
  | { type: "edit"; id: string | null }
  | { type: "setDefaultFontSize"; fontSize: number }
  | { type: "commit"; next: ContentState; selectedId?: string | null; editingId?: string | null }
  | { type: "undo" }
  | { type: "redo" };

const emptyEditor: EditorState = {
  overlays: [],
  fieldValues: {},
  selectedId: null,
  editingId: null,
  tool: "select",
  defaultFontSize: 11,
  showFields: true
};

function contentOf(state: EditorState): ContentState {
  return {
    overlays: state.overlays,
    fieldValues: state.fieldValues
  };
}

function reducer(state: HistoryState, action: Action): HistoryState {
  switch (action.type) {
    case "reset":
      return { present: emptyEditor, past: [], future: [] };
    case "setTool":
      return { ...state, present: { ...state.present, tool: action.tool, selectedId: null, editingId: null } };
    case "setShowFields":
      return { ...state, present: { ...state.present, showFields: action.show } };
    case "select":
      return { ...state, present: { ...state.present, selectedId: action.id, editingId: null } };
    case "edit":
      return { ...state, present: { ...state.present, selectedId: action.id, editingId: action.id } };
    case "setDefaultFontSize":
      return { ...state, present: { ...state.present, defaultFontSize: action.fontSize } };
    case "commit": {
      const past = [...state.past, contentOf(state.present)].slice(-50);
      return {
        past,
        future: [],
        present: {
          ...state.present,
          ...action.next,
          selectedId: action.selectedId ?? state.present.selectedId,
          editingId: action.editingId ?? state.present.editingId
        }
      };
    }
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) {
        return state;
      }
      return {
        past: state.past.slice(0, -1),
        future: [contentOf(state.present), ...state.future].slice(0, 50),
        present: { ...state.present, ...previous, selectedId: null, editingId: null }
      };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) {
        return state;
      }
      return {
        past: [...state.past, contentOf(state.present)].slice(-50),
        future: state.future.slice(1),
        present: { ...state.present, ...next, selectedId: null, editingId: null }
      };
    }
    default:
      return state;
  }
}

function createTextOverlay(pageIndex: number, x: number, y: number, fontSize: number): Overlay {
  return {
    id: crypto.randomUUID(),
    type: "text",
    pageIndex,
    x,
    y,
    width: 160,
    height: Math.ceil(fontSize * 1.45),
    text: "",
    fontSize
  };
}

function createCheckmarkOverlay(pageIndex: number, x: number, y: number): Overlay {
  return {
    id: crypto.randomUUID(),
    type: "checkmark",
    pageIndex,
    x,
    y,
    width: 12,
    height: 12
  };
}

function isTextEntryElement(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable);
}

function detectFieldType(annotation: Record<string, unknown>): DetectedFieldType {
  if (annotation.fieldType === "Tx") {
    return annotation.multiLine ? "multiline" : "text";
  }

  if (annotation.fieldType === "Ch") {
    return "dropdown";
  }

  if (annotation.fieldType === "Btn") {
    if (annotation.radioButton) {
      return "radio";
    }
    if (annotation.checkBox || annotation.fieldValue === "Off") {
      return "checkbox";
    }
  }

  return "unsupported";
}

function normalizeOptions(annotation: Record<string, unknown>): string[] | undefined {
  const options = annotation.options;
  if (!Array.isArray(options)) {
    return undefined;
  }

  return options.map((option) => {
    if (typeof option === "string") {
      return option;
    }
    if (option && typeof option === "object" && "displayValue" in option) {
      return String((option as { displayValue: unknown }).displayValue);
    }
    return String(option);
  });
}

async function detectFields(pdf: PDFDocumentProxy, pages: PageGeometry[]): Promise<DetectedFieldWidget[]> {
  const widgets: DetectedFieldWidget[] = [];
  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex + 1);
    const annotations = (await page.getAnnotations({ intent: "display" })) as Array<Record<string, unknown>>;
    for (const annotation of annotations) {
      if (annotation.subtype !== "Widget" || !Array.isArray(annotation.rect) || !annotation.fieldName) {
        continue;
      }

      const rect = annotationRectToTopLeft(annotation.rect as number[], pages[pageIndex]);
      widgets.push({
        id: `${String(annotation.fieldName)}:${pageIndex}:${widgets.length}`,
        fieldName: String(annotation.fieldName),
        type: detectFieldType(annotation),
        pageIndex,
        ...rect,
        options: normalizeOptions(annotation),
        exportValue: annotation.buttonValue ? String(annotation.buttonValue) : undefined
      });
    }
  }
  return widgets;
}

function App() {
  const [history, dispatch] = useReducer(reducer, { present: emptyEditor, past: [], future: [] });
  const editor = history.present;
  const [opened, setOpened] = useState<OpenedPdf | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageGeometry[]>([]);
  const [fields, setFields] = useState<DetectedFieldWidget[]>([]);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState("Open a PDF to start.");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [lastExportPath, setLastExportPath] = useState<string | undefined>();
  const [lastExportMessage, setLastExportMessage] = useState<string | null>(null);

  async function loadOpenedPdf(nextOpened: OpenedPdf) {
    setBusy(true);
    setStatus(nextOpened.size > 100 * 1024 * 1024 ? "Large PDF; performance may be slow." : "Loading PDF...");
    setLastExportMessage(null);
    try {
      const task = pdfjs.getDocument({ data: nextOpened.bytes.slice(0) });
      const nextPdf = await task.promise;
      const nextPages: PageGeometry[] = [];
      for (let index = 0; index < nextPdf.numPages; index += 1) {
        const page = await nextPdf.getPage(index + 1);
        const viewport = page.getViewport({ scale: 1 });
        nextPages.push({
          pageIndex: index,
          width: viewport.width,
          height: viewport.height,
          rotation: viewport.rotation
        });
      }
      const nextFields = await detectFields(nextPdf, nextPages);
      setOpened(nextOpened);
      setPdf(nextPdf);
      setPages(nextPages);
      setFields(nextFields);
      setZoom(1);
      setDirty(false);
      setLastExportPath(undefined);
      dispatch({ type: "reset" });
      setStatus(nextFields.length > 0 ? `${nextFields.length} detected fields.` : "No fillable fields found. Use Text or Checkmark to fill this PDF.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Password-protected, encrypted, or invalid PDF is not supported.");
    } finally {
      setBusy(false);
    }
  }

  async function openPdf() {
    if (dirty && !confirm("Discard current edits?")) {
      return;
    }
    setBusy(true);
    try {
      const nextOpened = await window.pdfApp.openPdf();
      if (nextOpened) {
        await loadOpenedPdf(nextOpened);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to open PDF.");
    } finally {
      setBusy(false);
    }
  }

  async function exportPdf() {
    if (!opened || !pdf) {
      return;
    }

    const invalid = findUnsupportedManualText(editor.overlays);
    if (invalid) {
      setStatus(`Export blocked: unsupported characters in manual text on page ${invalid.pageIndex + 1}.`);
      return;
    }

    const snapshot: ExportSnapshot = {
      overlays: editor.overlays
        .map((overlay) => (overlay.type === "text" ? { ...overlay, text: normalizeManualTextForExport(overlay.text) } : overlay))
        .filter((overlay) => overlay.type !== "text" || overlay.text.trim().length > 0),
      fieldValues: editor.fieldValues,
      fields,
      pages
    };

    setBusy(true);
    setStatus("Exporting...");
    setLastExportMessage(null);
    try {
      const result = await window.pdfApp.exportPdf(snapshot, lastExportPath);
      if (result) {
        setLastExportPath(result.filePath);
        setDirty(false);
        setStatus("Export complete.");
        setLastExportMessage(result.filePath);
      } else {
        setStatus("Export canceled.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? `Export failed: ${error.message}` : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  function commit(next: ContentState, selectedId?: string | null, editingId?: string | null) {
    dispatch({ type: "commit", next, selectedId, editingId });
    setDirty(true);
    setLastExportMessage(null);
  }

  function updateOverlay(nextOverlay: Overlay, selectedId: string | null = nextOverlay.id, editingId = editor.editingId) {
    commit(
      {
        overlays: editor.overlays.map((overlay) => (overlay.id === nextOverlay.id ? nextOverlay : overlay)),
        fieldValues: editor.fieldValues
      },
      selectedId,
      editingId
    );
  }

  function removeSelected() {
    if (!editor.selectedId) {
      return;
    }
    commit(
      {
        overlays: editor.overlays.filter((overlay) => overlay.id !== editor.selectedId),
        fieldValues: editor.fieldValues
      },
      null,
      null
    );
  }

  function duplicateSelected() {
    const selected = editor.overlays.find((overlay) => overlay.id === editor.selectedId);
    if (!selected) {
      return;
    }
    const copy = {
      ...selected,
      id: crypto.randomUUID(),
      x: selected.x + 10,
      y: selected.y + 10
    };
    const page = pages[selected.pageIndex];
    const clamped = page ? ({ ...copy, ...clampRectToPage(copy, page) } as Overlay) : copy;
    commit({ overlays: [...editor.overlays, clamped], fieldValues: editor.fieldValues }, clamped.id, null);
  }

  function setFieldValue(field: DetectedFieldWidget, value: FieldValue) {
    commit({
      overlays: editor.overlays,
      fieldValues: {
        ...editor.fieldValues,
        [field.fieldName]: value
      }
    });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;

      if (command && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openPdf();
      } else if (command && event.key.toLowerCase() === "e") {
        event.preventDefault();
        void exportPdf();
      } else if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
        setDirty(true);
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        dispatch({ type: "redo" });
        setDirty(true);
      } else if (command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        if (editor.selectedId && !isTextEntryElement(document.activeElement)) {
          event.preventDefault();
          removeSelected();
        }
      } else if (event.key === "Escape") {
        dispatch({ type: "select", id: null });
      } else if (event.key === "Enter" && editor.selectedId && !editor.editingId) {
        const selected = editor.overlays.find((overlay) => overlay.id === editor.selectedId);
        if (selected?.type === "text") {
          event.preventDefault();
          dispatch({ type: "edit", id: selected.id });
        }
      } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && editor.selectedId) {
        const selected = editor.overlays.find((overlay) => overlay.id === editor.selectedId);
        const page = selected ? pages[selected.pageIndex] : undefined;
        if (!selected || !page || isTextEntryElement(document.activeElement)) {
          return;
        }
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
        const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
        updateOverlay({ ...selected, ...nudgeRect(selected, page, dx, dy) });
      } else if (!command && !event.altKey) {
        if (event.key.toLowerCase() === "v") {
          dispatch({ type: "setTool", tool: "select" });
        } else if (event.key.toLowerCase() === "t") {
          dispatch({ type: "setTool", tool: "text" });
        } else if (event.key.toLowerCase() === "c") {
          dispatch({ type: "setTool", tool: "checkmark" });
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, editor, pages]);

  useEffect(() => {
    window.pdfApp.setDirtyState(dirty);
  }, [dirty]);

  const selected = editor.overlays.find((overlay) => overlay.id === editor.selectedId);
  const unsupportedCount = fields.filter((field) => field.type === "unsupported").length;

  return (
    <div className="app">
      <header className="toolbar">
        <button type="button" onClick={openPdf} disabled={busy}>
          Open PDF
        </button>
        <button type="button" onClick={exportPdf} disabled={!opened || busy}>
          Export Filled PDF
        </button>
        <span className="divider" />
        <ToolButton tool="select" current={editor.tool} dispatch={dispatch} label="Select" />
        <ToolButton tool="text" current={editor.tool} dispatch={dispatch} label="Text" />
        <ToolButton tool="checkmark" current={editor.tool} dispatch={dispatch} label="Checkmark" />
        <span className="divider" />
        <button type="button" onClick={() => dispatch({ type: "undo" })} disabled={history.past.length === 0}>
          Undo
        </button>
        <button type="button" onClick={() => dispatch({ type: "redo" })} disabled={history.future.length === 0}>
          Redo
        </button>
        <button type="button" onClick={duplicateSelected} disabled={!selected}>
          Duplicate
        </button>
        <button type="button" onClick={removeSelected} disabled={!selected}>
          Delete
        </button>
        <span className="divider" />
        <label className="field-control">
          Font
          <input
            type="number"
            min="6"
            max="36"
            value={selected?.type === "text" ? selected.fontSize : editor.defaultFontSize}
            onChange={(event) => {
              const fontSize = Number(event.currentTarget.value);
              if (selected?.type === "text") {
                updateOverlay({ ...selected, fontSize, height: Math.ceil(fontSize * 1.45) });
              } else {
                dispatch({ type: "setDefaultFontSize", fontSize });
              }
            }}
          />
        </label>
        <span className="divider" />
        <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>
          -
        </button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((value) => Math.min(3, value + 0.1))}>
          +
        </button>
        <button type="button" onClick={() => setZoom(1)}>
          Fit
        </button>
        <label className="field-toggle">
          <input type="checkbox" checked={editor.showFields} onChange={(event) => dispatch({ type: "setShowFields", show: event.currentTarget.checked })} />
          Show Fields
        </label>
        <span className="spacer" />
        <button type="button" onClick={() => alert(shortcutsText)}>
          Help
        </button>
      </header>

      <main className="workspace">
        {!pdf ? (
          <section className="empty">
            <h1>Open a PDF to start.</h1>
            <p>Fill existing form fields or add text/checkmarks to flat PDFs.</p>
            <button type="button" onClick={openPdf} disabled={busy}>
              Open PDF
            </button>
          </section>
        ) : (
          <section className="pages">
            {Array.from({ length: pdf.numPages }, (_, index) => (
              <PdfPageView
                key={index}
                pdf={pdf}
                page={pages[index]}
                pageIndex={index}
                zoom={zoom}
                editor={editor}
                fields={fields.filter((field) => field.pageIndex === index)}
                commit={commit}
                updateOverlay={updateOverlay}
                setFieldValue={setFieldValue}
                dispatch={dispatch}
              />
            ))}
          </section>
        )}
      </main>

      <footer className="statusbar">
        <span>{busy ? "Working..." : status}</span>
        {unsupportedCount > 0 ? <span>{unsupportedCount} unsupported fields ignored.</span> : null}
        {dirty ? <span>Unsaved edits</span> : opened ? <span>Exported/clean</span> : null}
        {lastExportMessage ? (
          <span className="export-actions">
            <button type="button" onClick={() => window.pdfApp.openExternalFile(lastExportMessage)}>
              Open exported PDF
            </button>
            <button type="button" onClick={() => window.pdfApp.showItemInFolder(lastExportMessage)}>
              Show in folder
            </button>
          </span>
        ) : null}
      </footer>
    </div>
  );
}

function ToolButton({ tool, current, dispatch, label }: { tool: Tool; current: Tool; dispatch: React.Dispatch<Action>; label: string }) {
  return (
    <button type="button" className={current === tool ? "active" : ""} onClick={() => dispatch({ type: "setTool", tool })}>
      {label}
    </button>
  );
}

interface PageViewProps {
  pdf: PDFDocumentProxy;
  page: PageGeometry;
  pageIndex: number;
  zoom: number;
  editor: EditorState;
  fields: DetectedFieldWidget[];
  commit: (next: ContentState, selectedId?: string | null, editingId?: string | null) => void;
  updateOverlay: (overlay: Overlay, selectedId?: string | null, editingId?: string | null) => void;
  setFieldValue: (field: DetectedFieldWidget, value: FieldValue) => void;
  dispatch: React.Dispatch<Action>;
}

function PdfPageView({ pdf, page, pageIndex, zoom, editor, fields, commit, updateOverlay, setFieldValue, dispatch }: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const pdfPage: PDFPageProxy = await pdf.getPage(pageIndex + 1);
          if (canceled || !canvasRef.current) {
            return;
          }
          const viewport = pdfPage.getViewport({ scale: zoom });
          const canvas = canvasRef.current;
          const context = canvas.getContext("2d");
          if (!context) {
            return;
          }
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
          await renderTask.promise;
          setRenderError(null);
        } catch (error) {
          if (!canceled) {
            setRenderError(error instanceof Error ? error.message : "Page failed to render.");
          }
        }
      })();
    }, 120);

    return () => {
      canceled = true;
      window.clearTimeout(timer);
      renderTask?.cancel();
    };
  }, [pdf, pageIndex, zoom]);

  if (!page) {
    return null;
  }

  const pageOverlays = editor.overlays.filter((overlay) => overlay.pageIndex === pageIndex);
  const width = page.width * zoom;
  const height = page.height * zoom;

  function handlePageClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!pageRef.current || event.target !== event.currentTarget) {
      return;
    }
    const point = screenToPdfPoint({ x: event.clientX, y: event.clientY }, pageRef.current.getBoundingClientRect(), page, zoom);
    if (editor.tool === "text") {
      const created = createTextOverlay(pageIndex, point.x, point.y, editor.defaultFontSize);
      const overlay = { ...created, ...clampRectToPage(created, page) } as Overlay;
      commit({ overlays: [...editor.overlays, overlay], fieldValues: editor.fieldValues }, overlay.id, overlay.id);
    } else if (editor.tool === "checkmark") {
      const created = createCheckmarkOverlay(pageIndex, point.x, point.y);
      const overlay = { ...created, ...clampRectToPage(created, page) } as Overlay;
      commit({ overlays: [...editor.overlays, overlay], fieldValues: editor.fieldValues }, overlay.id, null);
    } else {
      dispatch({ type: "select", id: null });
    }
  }

  return (
    <article className="page-wrap">
      <div className="page-label">Page {pageIndex + 1}</div>
      <div ref={pageRef} className="page" style={{ width, height }} onMouseDown={handlePageClick}>
        <canvas ref={canvasRef} />
        {renderError ? <div className="page-error">Page failed to render.</div> : null}
        <div className="overlay-layer" style={{ width, height }} onMouseDown={handlePageClick}>
          {editor.showFields
            ? fields.map((field) => (
                <DetectedFieldOverlay key={field.id} field={field} value={editor.fieldValues[field.fieldName]} scale={zoom} setFieldValue={setFieldValue} />
              ))
            : null}
          {pageOverlays.map((overlay) => (
            <ManualOverlayView
              key={overlay.id}
              overlay={overlay}
              page={page}
              scale={zoom}
              selected={editor.selectedId === overlay.id}
              editing={editor.editingId === overlay.id}
              dispatch={dispatch}
              updateOverlay={updateOverlay}
            />
          ))}
        </div>
      </div>
    </article>
  );
}

function DetectedFieldOverlay({ field, value, scale, setFieldValue }: { field: DetectedFieldWidget; value: FieldValue | undefined; scale: number; setFieldValue: (field: DetectedFieldWidget, value: FieldValue) => void }) {
  const css = pdfRectToCss(field, scale);
  const style = {
    left: css.x,
    top: css.y,
    width: css.width,
    height: css.height
  };

  if (field.type === "text" || field.type === "multiline") {
    const common = {
      className: "detected-field",
      style,
      value: typeof value === "string" ? value : "",
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFieldValue(field, event.currentTarget.value)
    };
    return field.type === "multiline" ? <textarea {...common} /> : <input {...common} />;
  }

  if (field.type === "checkbox") {
    const checked = value === true;
    return (
      <button type="button" className={`detected-checkbox ${checked ? "checked" : ""}`} style={style} onClick={() => setFieldValue(field, !checked)} aria-label={field.fieldName}>
        {checked ? <CheckmarkSvg /> : null}
      </button>
    );
  }

  if (field.type === "dropdown") {
    return (
      <select className="detected-field" style={style} value={typeof value === "string" ? value : ""} onChange={(event) => setFieldValue(field, event.currentTarget.value)}>
        <option value="" />
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "radio") {
    return (
      <button type="button" className={`detected-radio ${value === field.exportValue ? "checked" : ""}`} style={style} onClick={() => setFieldValue(field, field.exportValue ?? field.fieldName)} aria-label={field.fieldName}>
        {value === field.exportValue ? <span /> : null}
      </button>
    );
  }

  return null;
}

function ManualOverlayView({ overlay, page, scale, selected, editing, dispatch, updateOverlay }: { overlay: Overlay; page: PageGeometry; scale: number; selected: boolean; editing: boolean; dispatch: React.Dispatch<Action>; updateOverlay: (overlay: Overlay, selectedId?: string | null, editingId?: string | null) => void }) {
  const css = pdfRectToCss(overlay, scale);
  const dragStart = useRef<{ x: number; y: number; overlay: Overlay; resize: boolean } | null>(null);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>, resize = false) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, y: event.clientY, overlay, resize };
    dispatch({ type: "select", id: overlay.id });
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (!start) {
      return;
    }
    event.stopPropagation();
    const dx = (event.clientX - start.x) / scale;
    const dy = (event.clientY - start.y) / scale;
    const next = start.resize
      ? {
          ...start.overlay,
          width: Math.max(6, start.overlay.width + dx),
          height: start.overlay.type === "checkmark" ? Math.max(6, start.overlay.width + dx) : start.overlay.height
        }
      : {
          ...start.overlay,
          x: start.overlay.x + dx,
          y: start.overlay.y + dy
        };
    updateOverlay({ ...next, ...clampRectToPage(next, page) } as Overlay);
  }

  function onPointerUp() {
    dragStart.current = null;
  }

  if (overlay.type === "text") {
    return (
      <div
        className={`manual-overlay text-overlay ${selected ? "selected" : ""}`}
        style={{ left: css.x, top: css.y, width: css.width, height: css.height, fontSize: overlay.fontSize * scale }}
        onPointerDown={(event) => !editing && onPointerDown(event)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={(event) => {
          event.stopPropagation();
          dispatch({ type: "edit", id: overlay.id });
        }}
      >
        {editing ? (
          <EditableText
            overlay={overlay}
            updateOverlay={updateOverlay}
            onDone={(text) => {
              dispatch({ type: "select", id: text.trim() ? overlay.id : null });
            }}
          />
        ) : (
          <span>{overlay.text || "Text"}</span>
        )}
        {selected ? <div className="resize-handle" onPointerDown={(event) => onPointerDown(event, true)} /> : null}
      </div>
    );
  }

  return (
    <div
      className={`manual-overlay check-overlay ${selected ? "selected" : ""}`}
      style={{ left: css.x, top: css.y, width: css.width, height: css.height }}
      onPointerDown={(event) => onPointerDown(event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <CheckmarkSvg />
      {selected ? <div className="resize-handle" onPointerDown={(event) => onPointerDown(event, true)} /> : null}
    </div>
  );
}

function EditableText({
  overlay,
  updateOverlay,
  onDone
}: {
  overlay: Extract<Overlay, { type: "text" }>;
  updateOverlay: (overlay: Overlay, selectedId?: string | null, editingId?: string | null) => void;
  onDone: (text: string) => void;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    element.textContent = overlay.text;
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [overlay.id]);

  function currentText() {
    return ref.current?.textContent ?? "";
  }

  return (
    <span
      ref={ref}
      className="text-editor"
      contentEditable
      suppressContentEditableWarning
      onInput={(event) => {
        const text = normalizeManualTextForExport(event.currentTarget.textContent ?? "");
        updateOverlay({ ...overlay, text, width: Math.max(80, text.length * overlay.fontSize * 0.65) }, overlay.id, overlay.id);
      }}
      onBlur={() => onDone(currentText())}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function CheckmarkSvg() {
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path d="M12 48 L40 78 L90 12" fill="none" stroke="black" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const shortcutsText = `Keyboard Shortcuts

Open: Ctrl/Cmd+O
Export: Ctrl/Cmd+E
Undo: Ctrl/Cmd+Z
Redo: Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y
Tools: V Select, T Text, C Checkmark
Duplicate: Ctrl/Cmd+D
Delete: Delete/Backspace
Nudge: Arrow keys, Shift+Arrow for 10 px`;

createRoot(document.getElementById("root")!).render(<App />);
