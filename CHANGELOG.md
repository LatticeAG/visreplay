# Changelog

## 1.1.0

- Production packaging, CI on Node 20 and 22, pack-install smoke, and
  `SECURITY.md`.
- `Session.end()` / `VisReplay.end()` set `endedAt` as a logical run marker.
- `onCaptureError` reports wrap and WebSocket capture failures without
  changing agent or socket results.
- Shared atomic writer with EXDEV copy fallback and mode `0o600`.
- Render helpers live in `src/render.ts` so the SDK barrel does not load the
  CLI.
- `recordDecision` stores believed/assumed/ignored context on `reasoning`
  metadata without changing `visreplay/session/1.0`.
- File-only Langfuse, OTLP/JSON, and LangSmith exporters. They write vendor
  documents; they do not upload.
