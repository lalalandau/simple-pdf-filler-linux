# Simple PDF Filler

Linux-first, local-only desktop app for filling PDFs. It can fill detected PDF form fields and place manual text/checkmark overlays on flat or scanned PDFs, then export a new flattened PDF.

## Development

```bash
npm install
npm run dev:electron
```

## Validation

```bash
npm run typecheck
npm run test
npm run build
```

## Package Linux AppImage

```bash
npm install
npm run package:linux
```

The AppImage is written to `release/`.

## MVP Scope

- Open one local PDF at a time.
- Render pages vertically.
- Fill detected text fields, checkboxes, radio buttons, and dropdowns best-effort.
- Add manual single-line text overlays and vector checkmarks.
- Export a new flattened PDF.
- Keep all processing local and offline.

## Known Limitations

- No password-protected or encrypted PDFs.
- No OCR or automatic flat-form field detection.
- No signatures, image overlays, stamps, or logos.
- No page rotate/delete/reorder/merge/split tools.
- No redaction or whiteout.
- No built-in printing.
- No autosave, recent files, telemetry, cloud sync, or auto-update.
- Manual overlay export guarantees basic Latin text only with Helvetica.
- No explicit RTL support.
- Digital signatures are not preserved.

