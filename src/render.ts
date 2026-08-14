/**
 * Presentation helpers for VisReplay debug exports. This module has no
 * Commander or filesystem imports so the SDK barrel can render reports
 * without loading the CLI.
 */

export type RenderFormat = 'json' | 'markdown' | 'html';
export type InteropExportFormat = 'langfuse' | 'otlp' | 'langsmith';
export type ExportFormat = RenderFormat | InteropExportFormat;

const KNOWN_EVENT_TYPES = ['input', 'reasoning', 'tool_call', 'tool_result', 'output', 'error'] as const;

interface DebugView {
  session: Record<string, unknown>;
  summary: Record<string, unknown>;
  timeline: Record<string, unknown>[];
  events: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
}

const FORMAT_ERROR = 'format must be one of: json, markdown, html, langfuse, otlp, langsmith';

/** Parse a supported export format, including conventional short aliases. */
export function parseExportFormat(value: string): ExportFormat {
  switch (value.trim().toLowerCase()) {
    case 'json':
      return 'json';
    case 'markdown':
    case 'md':
      return 'markdown';
    case 'html':
    case 'htm':
      return 'html';
    case 'langfuse':
      return 'langfuse';
    case 'otlp':
      return 'otlp';
    case 'langsmith':
      return 'langsmith';
    default:
      throw new Error(FORMAT_ERROR);
  }
}

export function isInteropExportFormat(format: string): format is InteropExportFormat {
  return format === 'langfuse' || format === 'otlp' || format === 'langsmith';
}

export function isRenderFormat(format: string): format is RenderFormat {
  return format === 'json' || format === 'markdown' || format === 'html';
}

/** Render an export with a trailing newline, ready for stdout or a file. */
export function renderExport(debugExport: unknown, format: ExportFormat = 'json'): string {
  switch (format) {
    case 'json':
      return `${stringifyJson(debugExport, 2)}\n`;
    case 'markdown':
      return `${renderMarkdownReport(debugExport)}\n`;
    case 'html':
      return `${renderHtmlTimeline(debugExport)}\n`;
    default:
      throw new Error(`renderExport does not support format "${format}"`);
  }
}

/**
 * Render a readable Markdown debugging report. The source debug export is
 * intentionally kept intact; this is a presentation format, not a new schema.
 */
export function renderMarkdownReport(debugExport: unknown): string {
  const view = toDebugView(debugExport);
  const eventCount = numberValue(view.summary.eventCount) ?? view.events.length;
  const errorCount = numberValue(view.summary.errorCount)
    ?? view.events.filter((event) => event.type === 'error').length;
  const sessionName = stringValue(view.session.sessionName) ?? 'unnamed session';
  const eventCounts = recordValue(view.summary.eventCounts);
  const lines = [
    '# VisReplay Debug Report',
    '',
    `Session: **${escapeMarkdownCell(sessionName)}**`,
    '',
    '## Session',
    '',
    '| Field | Value |',
    '| --- | --- |',
    markdownRow('Session ID', view.session.sessionId),
    markdownRow('Session name', view.session.sessionName),
    markdownRow('Agent type', view.session.agentType),
    markdownRow('Started at', view.session.startedAt),
    markdownRow('Ended at', view.session.endedAt),
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    markdownRow('Events', eventCount),
    markdownRow('Errors', errorCount)
  ];

  for (const type of orderedEventTypes(eventCounts)) {
    lines.push(markdownRow(`${type} events`, eventCounts[type]));
  }

  const firstError = recordValue(view.summary.firstError);
  if (Object.keys(firstError).length > 0) {
    lines.push(markdownRow('First error', firstError.message));
    lines.push(markdownRow('First error index', firstError.index));
  }

  const decisions = decisionEntries(view);
  lines.push('', '## Decisions', '');
  if (decisions.length === 0) {
    lines.push('_No decision records were captured._');
  } else {
    for (const entry of decisions) {
      const index = entry.index ?? '';
      const preview = previewFor(entry);
      const decision = recordValue(entry.decision);
      lines.push(`### Decision ${escapeMarkdownCell(index)}`, '');
      lines.push(`Preview: ${escapeMarkdownCell(preview)}`, '');
      for (const key of ['believed', 'assumed', 'overweighted', 'ignored', 'alternatives', 'confidence'] as const) {
        if (!Object.prototype.hasOwnProperty.call(decision, key) || decision[key] === undefined) {
          continue;
        }
        lines.push(`- **${key}:** \`${escapeInlineCode(stringifyJson(decision[key], 0))}\``);
      }
      lines.push('');
    }
  }

  lines.push('', '## Timeline', '');
  if (view.timeline.length === 0) {
    lines.push('_No events were recorded._');
  } else {
    lines.push('| # | Timestamp | Type | Method / tool | Preview |');
    lines.push('| ---: | --- | --- | --- | --- |');
    for (const [position, event] of view.timeline.entries()) {
      const label = firstDefined(event.method, event.name);
      lines.push([
        markdownCell(event.index ?? position),
        markdownCell(event.timestamp),
        markdownCell(event.type),
        markdownCell(label),
        markdownCell(previewFor(event))
      ].join('|'));
    }
  }

  lines.push('', '## Event details', '');
  if (view.events.length === 0) {
    lines.push('_No event payloads were recorded._');
  } else {
    for (const [position, event] of view.events.entries()) {
      const index = event.index ?? position;
      const type = stringValue(event.type) ?? 'event';
      lines.push(`### Event ${escapeMarkdownCell(index)}: \`${escapeInlineCode(type)}\``, '');
      lines.push(markdownJsonBlock(event), '');
    }
  }

  return lines.join('\n').trimEnd();
}

/** Render a portable, static HTML timeline suitable for sharing locally. */
export function renderHtmlTimeline(debugExport: unknown): string {
  const view = toDebugView(debugExport);
  const sessionName = stringValue(view.session.sessionName) ?? 'unnamed session';
  const eventCount = numberValue(view.summary.eventCount) ?? view.events.length;
  const errorCount = numberValue(view.summary.errorCount)
    ?? view.events.filter((event) => event.type === 'error').length;
  const eventsByIndex = new Map<number, Record<string, unknown>>();

  for (const [position, event] of view.events.entries()) {
    eventsByIndex.set(indexValue(event.index, position), event);
  }

  const timelineRows = view.timeline.map((event, position) => {
    const index = indexValue(event.index, position);
    const rawEvent = eventsByIndex.get(index);
    const detail = rawEvent === undefined
      ? ''
      : `<details><summary>Raw event</summary><pre>${escapeHtml(stringifyJson(rawEvent, 2))}</pre></details>`;

    return `<tr>
      <td>${escapeHtml(String(index))}</td>
      <td>${escapeHtml(displayValue(event.timestamp))}</td>
      <td><span class="type type-${escapeHtml(stringValue(event.type) ?? 'unknown')}">${escapeHtml(displayValue(event.type))}</span></td>
      <td>${escapeHtml(displayValue(firstDefined(event.method, event.name)))}</td>
      <td>${escapeHtml(previewFor(event))}${detail}</td>
    </tr>`;
  }).join('\n');

  const eventCounts = recordValue(view.summary.eventCounts);
  const countMarkup = orderedEventTypes(eventCounts)
    .map((type) => `<li><span>${escapeHtml(type)}</span><strong>${escapeHtml(displayValue(eventCounts[type]))}</strong></li>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VisReplay timeline: ${escapeHtml(sessionName)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7fb; color: #182033; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f7fb; }
    main { max-width: 1180px; margin: 0 auto; padding: 48px 24px 72px; }
    .eyebrow { color: #5b46d8; font-size: .73rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 9px 0 6px; font-size: clamp(2rem, 5vw, 3.6rem); letter-spacing: -.055em; }
    .muted { color: #667085; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 32px 0; }
    .stat, .panel { background: #fff; border: 1px solid #e5e7ef; border-radius: 16px; box-shadow: 0 8px 28px rgba(24, 32, 51, .055); }
    .stat { padding: 19px; }
    .stat span { display: block; color: #667085; font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .075em; }
    .stat strong { display: block; margin-top: 6px; font-size: 1.7rem; letter-spacing: -.045em; }
    .panel { overflow: hidden; }
    .panel h2 { margin: 0; padding: 20px 22px; font-size: 1.1rem; border-bottom: 1px solid #e5e7ef; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { padding: 14px 16px; text-align: left; vertical-align: top; border-bottom: 1px solid #edf0f5; }
    th { background: #fafbfe; color: #667085; font-size: .73rem; letter-spacing: .08em; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
    .type { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #edf1ff; color: #3447a6; font-size: .75rem; font-weight: 800; letter-spacing: .03em; }
    .type-error { background: #fff0f1; color: #b4233a; }
    .type-output, .type-tool_result { background: #e9fbf2; color: #087443; }
    details { margin-top: 10px; color: #475467; }
    summary { cursor: pointer; font-size: .8rem; font-weight: 700; }
    pre { margin: 10px 0 0; padding: 12px; overflow: auto; border-radius: 9px; background: #171b28; color: #e7ecff; font: .77rem/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 0; padding: 20px 22px; list-style: none; }
    .counts li { display: flex; justify-content: space-between; padding: 10px 12px; border-radius: 10px; background: #f7f8fc; color: #667085; font-size: .85rem; }
    .counts strong { color: #182033; }
    .empty { padding: 32px 22px; color: #667085; }
    @media (max-width: 700px) { main { padding: 30px 14px 48px; } .stats { grid-template-columns: 1fr; } .panel { overflow-x: auto; } table { min-width: 760px; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">VisReplay · HTML timeline</div>
    <h1>${escapeHtml(sessionName)}</h1>
    <p class="muted">${escapeHtml(displayValue(view.session.agentType))} · started ${escapeHtml(displayValue(view.session.startedAt))}</p>
    <section class="stats" aria-label="Session summary">
      <article class="stat"><span>Events</span><strong>${escapeHtml(String(eventCount))}</strong></article>
      <article class="stat"><span>Errors</span><strong>${escapeHtml(String(errorCount))}</strong></article>
      <article class="stat"><span>Session ID</span><strong>${escapeHtml(truncate(displayValue(view.session.sessionId), 28))}</strong></article>
    </section>
    <section class="panel" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">Timeline</h2>
      ${timelineRows.length > 0 ? `<table><thead><tr><th>#</th><th>Timestamp</th><th>Type</th><th>Method / tool</th><th>Preview</th></tr></thead><tbody>${timelineRows}</tbody></table>` : '<p class="empty">No events were recorded.</p>'}
    </section>
    <section class="panel" aria-labelledby="counts-heading" style="margin-top: 16px">
      <h2 id="counts-heading">Event counts</h2>
      ${countMarkup.length > 0 ? `<ul class="counts">${countMarkup}</ul>` : '<p class="empty">No event counts are available.</p>'}
    </section>
    <section class="panel" aria-labelledby="decisions-heading" style="margin-top: 16px">
      <h2 id="decisions-heading">Decisions</h2>
      ${renderHtmlDecisions(view)}
    </section>
  </main>
</body>
</html>`;
}

/**
 * Render a self-contained HTML debugger. It deliberately embeds no remote
 * assets and only creates a bounded number of DOM rows at once, keeping large
 * recordings usable in a browser.
 */
export function renderDebugViewer(debugExport: unknown): string {
  const view = toDebugView(debugExport);
  const sessionName = stringValue(view.session.sessionName) ?? 'unnamed session';
  const serializedData = stringifyJsonForScript(debugExport);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VisReplay debug viewer: ${escapeHtml(sessionName)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f5fa; color: #172033; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: #f4f5fa; }
    button, input { font: inherit; }
    button { cursor: pointer; }
    .shell { max-width: 1440px; margin: 0 auto; padding: 28px 24px 48px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
    .eyebrow { margin-bottom: 7px; color: #6553db; font-size: .72rem; font-weight: 850; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(1.85rem, 4vw, 3.2rem); line-height: 1; letter-spacing: -.06em; }
    .subtitle { margin: 10px 0 0; color: #697386; font-size: .95rem; }
    .shortcut { padding: 9px 11px; border: 1px solid #dfe3ec; border-radius: 9px; color: #697386; background: #fff; font-size: .77rem; white-space: nowrap; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric { padding: 14px 16px; border: 1px solid #e4e7ef; border-radius: 13px; background: #fff; box-shadow: 0 8px 24px rgba(24, 32, 51, .045); }
    .metric span { display: block; color: #697386; font-size: .71rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 4px; font-size: 1.35rem; letter-spacing: -.04em; }
    .workspace { display: grid; grid-template-columns: minmax(290px, .8fr) minmax(0, 1.4fr); gap: 16px; min-height: 620px; }
    .panel { min-width: 0; overflow: hidden; border: 1px solid #e2e6ef; border-radius: 16px; background: #fff; box-shadow: 0 12px 32px rgba(24, 32, 51, .055); }
    .controls { padding: 14px; border-bottom: 1px solid #edf0f4; }
    .search { width: 100%; padding: 10px 12px; border: 1px solid #d9deea; border-radius: 9px; outline: none; color: #172033; }
    .search:focus { border-color: #7967e8; box-shadow: 0 0 0 3px rgba(121, 103, 232, .13); }
    .filters { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .filter { padding: 5px 8px; border: 1px solid #e0e4ed; border-radius: 999px; background: #fff; color: #596579; font-size: .73rem; font-weight: 750; }
    .filter[aria-pressed="true"] { border-color: #6250d8; background: #6250d8; color: #fff; }
    .event-count { display: block; margin-top: 11px; color: #697386; font-size: .78rem; }
    .event-list { max-height: 643px; overflow: auto; padding: 7px; }
    .event { display: block; width: 100%; margin: 0 0 4px; padding: 12px; border: 0; border-radius: 10px; background: transparent; color: inherit; text-align: left; }
    .event:hover { background: #f6f7fb; }
    .event[aria-current="true"] { background: #efedff; box-shadow: inset 3px 0 0 #6856df; }
    .event-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .event-index { color: #657085; font: .75rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .badge { padding: 3px 7px; border-radius: 999px; background: #ecf0ff; color: #3d4fa7; font-size: .67rem; font-weight: 850; letter-spacing: .04em; text-transform: uppercase; }
    .badge.error { background: #fff0f1; color: #bd2740; }
    .badge.output, .badge.tool_result { background: #e8fbf2; color: #087847; }
    .event-preview { display: -webkit-box; margin-top: 7px; overflow: hidden; color: #3d4658; font-size: .83rem; line-height: 1.35; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .event-time { display: block; margin-top: 6px; color: #8a94a6; font-size: .7rem; }
    .load-more { display: block; width: calc(100% - 14px); margin: 8px 7px 4px; padding: 9px; border: 1px solid #dce1eb; border-radius: 9px; background: #fff; color: #5545c3; font-size: .8rem; font-weight: 800; }
    .detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid #edf0f4; }
    .detail-heading { margin: 0; font-size: 1rem; letter-spacing: -.02em; }
    .navigation { display: flex; gap: 6px; }
    .navigation button { min-width: 34px; padding: 6px 9px; border: 1px solid #dce1eb; border-radius: 8px; background: #fff; color: #485368; font-weight: 800; }
    .navigation button:disabled { cursor: not-allowed; opacity: .45; }
    .detail-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; padding: 16px 18px 0; }
    .meta { padding: 10px; border-radius: 9px; background: #f7f8fb; }
    .meta span { display: block; color: #7b8597; font-size: .67rem; font-weight: 800; letter-spacing: .075em; text-transform: uppercase; }
    .meta strong { display: block; margin-top: 4px; overflow-wrap: anywhere; font-size: .82rem; }
    .payload-label { display: block; margin: 18px 18px 8px; color: #697386; font-size: .72rem; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .payload { min-height: 390px; margin: 0 18px 18px; padding: 15px; overflow: auto; border-radius: 11px; background: #181d2a; color: #e7ecff; font: .8rem/1.57 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { padding: 42px 18px; color: #697386; text-align: center; }
    .why { margin: 16px 18px 0; padding: 14px; border: 1px solid #ece4ff; border-radius: 11px; background: #f7f4ff; }
    .why h3 { margin: 0 0 8px; font-size: .82rem; letter-spacing: .06em; text-transform: uppercase; color: #5545c3; }
    .why ul { margin: 0; padding-left: 18px; }
    .why li { margin: 0 0 6px; overflow-wrap: anywhere; font-size: .84rem; }
    .viewer-error { max-width: 720px; margin: 80px auto; padding: 22px; border: 1px solid #f2c5cb; border-radius: 12px; background: #fff7f8; color: #9f1e33; }
    @media (max-width: 900px) { .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .workspace { grid-template-columns: 1fr; } .event-list { max-height: 390px; } }
    @media (max-width: 560px) { .shell { padding: 20px 12px 36px; } .topbar { display: block; } .shortcut { display: inline-block; margin-top: 14px; } .summary { gap: 7px; } .metric { padding: 11px; } .detail-meta { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <div class="eyebrow">VisReplay · local interactive debugger</div>
        <h1>${escapeHtml(sessionName)}</h1>
        <p class="subtitle" id="session-subtitle"></p>
      </div>
      <div class="shortcut">↑ ↓ / ← → to step through events</div>
    </header>
    <section class="summary" id="summary" aria-label="Session summary"></section>
    <section class="workspace">
      <aside class="panel" aria-label="Recorded events">
        <div class="controls">
          <input class="search" id="search" type="search" placeholder="Filter events by text, method, or tool" aria-label="Filter events">
          <div class="filters" role="group" aria-label="Filter by event type">
            <button class="filter" type="button" data-filter="all" aria-pressed="true">All</button>
            <button class="filter" type="button" data-filter="input" aria-pressed="false">Input</button>
            <button class="filter" type="button" data-filter="reasoning" aria-pressed="false">Reasoning</button>
            <button class="filter" type="button" data-filter="tool_call" aria-pressed="false">Tool call</button>
            <button class="filter" type="button" data-filter="tool_result" aria-pressed="false">Tool result</button>
            <button class="filter" type="button" data-filter="output" aria-pressed="false">Output</button>
            <button class="filter" type="button" data-filter="error" aria-pressed="false">Error</button>
            <button class="filter" type="button" data-filter="decision" aria-pressed="false">Decisions</button>
          </div>
          <span class="event-count" id="event-count"></span>
        </div>
        <div class="event-list" id="event-list" aria-live="polite"></div>
        <button class="load-more" id="load-more" type="button" hidden>Load more events</button>
      </aside>
      <section class="panel" aria-label="Selected event details">
        <div class="detail-head">
          <h2 class="detail-heading" id="detail-heading">Select an event</h2>
          <div class="navigation">
            <button id="previous" type="button" aria-label="Previous event">←</button>
            <button id="next" type="button" aria-label="Next event">→</button>
          </div>
        </div>
        <div id="detail"></div>
      </section>
    </section>
  </main>
  <script id="visreplay-debug-data" type="application/json">${serializedData}</script>
  <script>
    (function () {
      'use strict';
      var source = document.getElementById('visreplay-debug-data');
      var debug;
      try {
        debug = JSON.parse(source.textContent || '{}');
      } catch (error) {
        document.body.innerHTML = '<p class="viewer-error">This debug viewer could not read its embedded session data.</p>';
        return;
      }
      if (debug === null || typeof debug !== 'object' || Array.isArray(debug)) {
        debug = {};
      }

      function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      }
      function record(value) {
        return isRecord(value) ? value : {};
      }
      function eventRecord(value) {
        return isRecord(value) ? value : { content: value };
      }
      function text(value) {
        if (value === undefined) return '(none)';
        if (value === null) return 'null';
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch (error) { return String(value); }
      }
      function pretty(value) {
        try { return JSON.stringify(value, null, 2); } catch (error) { return String(value); }
      }
      function esc(value) {
        return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
      function trim(value, length) {
        var result = text(value);
        return result.length > length ? result.slice(0, length - 3) + '...' : result;
      }
      function eventPreview(event) {
        if (event.preview !== undefined) return trim(event.preview, 220);
        var candidate = event.error;
        if (candidate === undefined) candidate = event.content;
        if (candidate === undefined) candidate = event.result;
        if (candidate === undefined) candidate = event.name;
        if (candidate === undefined) candidate = event.method;
        return trim(candidate === undefined ? event.type : candidate, 220);
      }
      function eventIndex(event, fallback) {
        return typeof event.index === 'number' && Number.isFinite(event.index) ? event.index : fallback;
      }
      function eventType(event) {
        return typeof event.type === 'string' ? event.type : 'unknown';
      }
      function decisionRecord(event) {
        var metadata = record(event.metadata);
        var visreplay = metadata.visreplay;
        if (eventType(event) !== 'reasoning' || !isRecord(visreplay)) return null;
        if (visreplay.kind !== 'decision' || visreplay.schema !== 'visreplay/decision/1.0') return null;
        return visreplay;
      }

      var session = record(debug.session);
      var summary = record(debug.summary);
      var rawEvents = Array.isArray(debug.events) ? debug.events : [];
      if (rawEvents.length === 0 && Array.isArray(debug.timeline)) rawEvents = debug.timeline;
      var events = rawEvents.map(eventRecord);
      var state = { filter: 'all', query: '', limit: 250, selected: events.length > 0 ? 0 : -1 };
      var search = document.getElementById('search');
      var list = document.getElementById('event-list');
      var count = document.getElementById('event-count');
      var detail = document.getElementById('detail');
      var detailHeading = document.getElementById('detail-heading');
      var previous = document.getElementById('previous');
      var next = document.getElementById('next');
      var loadMore = document.getElementById('load-more');
      var subtitle = document.getElementById('session-subtitle');
      var summaryElement = document.getElementById('summary');

      subtitle.textContent = text(session.agentType) + ' · started ' + text(session.startedAt);
      var countValues = record(summary.eventCounts);
      var summaryCount = typeof summary.eventCount === 'number' ? summary.eventCount : events.length;
      var summaryErrors = typeof summary.errorCount === 'number' ? summary.errorCount : events.filter(function (event) { return eventType(event) === 'error'; }).length;
      var summaryDecisions = typeof summary.decisionCount === 'number' ? summary.decisionCount : events.filter(function (event) { return decisionRecord(event) !== null; }).length;
      summaryElement.innerHTML = '<article class="metric"><span>Events</span><strong>' + esc(summaryCount) + '</strong></article>'
        + '<article class="metric"><span>Errors</span><strong>' + esc(summaryErrors) + '</strong></article>'
        + '<article class="metric"><span>Tool calls</span><strong>' + esc(countValues.tool_call === undefined ? 0 : countValues.tool_call) + '</strong></article>'
        + '<article class="metric"><span>Decisions</span><strong>' + esc(summaryDecisions) + '</strong></article>'
        + '<article class="metric"><span>Session ID</span><strong>' + esc(trim(session.sessionId, 24)) + '</strong></article>';

      function filteredEvents() {
        var query = state.query.trim().toLowerCase();
        return events.map(function (event, sourceIndex) { return { event: event, sourceIndex: sourceIndex }; }).filter(function (entry) {
          if (state.filter === 'decision') {
            if (decisionRecord(entry.event) === null) return false;
          } else if (state.filter !== 'all' && eventType(entry.event) !== state.filter) {
            return false;
          }
          if (!query) return true;
          var haystack = [eventPreview(entry.event), entry.event.method, entry.event.name, entry.event.error, entry.event.type].map(text).join(' ').toLowerCase();
          return haystack.indexOf(query) !== -1;
        });
      }
      function ensureSelection(filtered) {
        if (filtered.length === 0) {
          state.selected = -1;
          return;
        }
        var exists = filtered.some(function (entry) { return entry.sourceIndex === state.selected; });
        if (!exists) state.selected = filtered[0].sourceIndex;
      }
      function renderDetail(filtered) {
        var current = state.selected >= 0 ? events[state.selected] : null;
        var currentPosition = filtered.findIndex(function (entry) { return entry.sourceIndex === state.selected; });
        previous.disabled = currentPosition <= 0;
        next.disabled = currentPosition < 0 || currentPosition >= filtered.length - 1;
        if (!current) {
          detailHeading.textContent = 'No event selected';
          detail.innerHTML = '<p class="empty">No event matches the current filter.</p>';
          return;
        }
        var index = eventIndex(current, state.selected);
        var type = eventType(current);
        var why = '';
        var decision = decisionRecord(current);
        if (decision) {
          var whyKeys = ['believed', 'assumed', 'overweighted', 'ignored', 'alternatives', 'confidence'];
          var whyItems = whyKeys.filter(function (key) { return decision[key] !== undefined; }).map(function (key) {
            return '<li><strong>' + esc(key) + '</strong>: ' + esc(pretty(decision[key])) + '</li>';
          }).join('');
          why = '<div class="why"><h3>Why this step</h3><ul>' + whyItems + '</ul></div>';
        }
        detailHeading.textContent = 'Event ' + index + ' · ' + type;
        detail.innerHTML = '<div class="detail-meta">'
          + '<div class="meta"><span>Timestamp</span><strong>' + esc(text(current.timestamp)) + '</strong></div>'
          + '<div class="meta"><span>Method / tool</span><strong>' + esc(text(current.method === undefined ? current.name : current.method)) + '</strong></div>'
          + '<div class="meta"><span>Type</span><strong>' + esc(type) + '</strong></div>'
          + '<div class="meta"><span>Position</span><strong>' + esc((currentPosition + 1) + ' of ' + filtered.length) + '</strong></div>'
          + '</div>' + why + '<span class="payload-label">Full recorded event</span><pre class="payload">' + esc(pretty(current)) + '</pre>';
      }
      function render() {
        var filtered = filteredEvents();
        ensureSelection(filtered);
        count.textContent = filtered.length + ' of ' + events.length + ' events';
        var visible = filtered.slice(0, state.limit);
        if (visible.length === 0) {
          list.innerHTML = '<p class="empty">No events match this filter.</p>';
        } else {
          list.innerHTML = visible.map(function (entry) {
            var event = entry.event;
            var type = eventType(event);
            var active = entry.sourceIndex === state.selected;
            return '<button class="event" type="button" data-source-index="' + entry.sourceIndex + '" aria-current="' + active + '">'
              + '<span class="event-top"><span class="event-index">#' + esc(eventIndex(event, entry.sourceIndex)) + '</span><span class="badge ' + esc(type) + '">' + esc(type.replace(/_/g, ' ')) + '</span></span>'
              + '<span class="event-preview">' + esc(eventPreview(event)) + '</span>'
              + '<span class="event-time">' + esc(text(event.timestamp)) + '</span></button>';
          }).join('');
        }
        loadMore.hidden = filtered.length <= state.limit;
        renderDetail(filtered);
      }
      function move(direction) {
        var filtered = filteredEvents();
        ensureSelection(filtered);
        var position = filtered.findIndex(function (entry) { return entry.sourceIndex === state.selected; });
        if (position === -1) return;
        var nextPosition = Math.max(0, Math.min(filtered.length - 1, position + direction));
        state.selected = filtered[nextPosition].sourceIndex;
        if (nextPosition >= state.limit) state.limit = nextPosition + 1;
        render();
      }

      list.addEventListener('click', function (event) {
        var target = event.target.closest('[data-source-index]');
        if (!target) return;
        state.selected = Number(target.getAttribute('data-source-index'));
        render();
      });
      search.addEventListener('input', function () { state.query = search.value; state.limit = 250; render(); });
      document.querySelectorAll('[data-filter]').forEach(function (button) {
        button.addEventListener('click', function () {
          state.filter = button.getAttribute('data-filter') || 'all';
          state.limit = 250;
          document.querySelectorAll('[data-filter]').forEach(function (item) { item.setAttribute('aria-pressed', String(item === button)); });
          render();
        });
      });
      previous.addEventListener('click', function () { move(-1); });
      next.addEventListener('click', function () { move(1); });
      loadMore.addEventListener('click', function () { state.limit += 250; render(); });
      window.addEventListener('keydown', function (event) {
        if (event.target === search) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      });
      render();
    }());
  </script>
</body>
</html>`;
}

function resolveDecisionEntries(
  root: Record<string, unknown>,
  events: Record<string, unknown>[]
): Record<string, unknown>[] {
  const supplied = arrayValue(root.decisions).map(eventValue);
  if (supplied.length > 0) {
    return supplied;
  }
  return extractDecisionsFromEvents(events);
}

function decisionEntries(view: DebugView): Record<string, unknown>[] {
  if (view.decisions.length > 0) {
    return view.decisions;
  }
  return extractDecisionsFromEvents(view.events);
}

function extractDecisionsFromEvents(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.flatMap((event, position) => {
    const visreplay = recordValue(event.metadata).visreplay;
    if (event.type !== 'reasoning' || !isDecisionMetadataRecord(visreplay)) {
      return [];
    }
    return [{
      index: event.index ?? position,
      timestamp: event.timestamp,
      preview: previewFor(event),
      decision: visreplay
    }];
  });
}

function isDecisionMetadataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === 'decision'
    && (value as Record<string, unknown>).schema === 'visreplay/decision/1.0';
}

function renderHtmlDecisions(view: DebugView): string {
  const decisions = decisionEntries(view);
  if (decisions.length === 0) {
    return '<p class="empty">No decision records were captured.</p>';
  }

  return decisions.map((entry) => {
    const decision = recordValue(entry.decision);
    const fields = ['believed', 'assumed', 'overweighted', 'ignored', 'alternatives', 'confidence']
      .filter((key) => Object.prototype.hasOwnProperty.call(decision, key) && decision[key] !== undefined)
      .map((key) => `<li><strong>${escapeHtml(key)}</strong>: <code>${escapeHtml(stringifyJson(decision[key], 0))}</code></li>`)
      .join('');
    return `<article style="padding: 20px 22px; text-align: left">
      <strong>Decision ${escapeHtml(displayValue(entry.index))}</strong>
      <p>${escapeHtml(previewFor(entry))}</p>
      <ul>${fields}</ul>
    </article>`;
  }).join('');
}

function toDebugView(value: unknown): DebugView {
  const root = recordValue(value);
  const session = recordValue(root.session);
  const summary = recordValue(root.summary);
  const events = arrayValue(root.events).map(eventValue);
  const suppliedTimeline = arrayValue(root.timeline).map(eventValue);
  const timeline = suppliedTimeline.length > 0 || events.length === 0
    ? suppliedTimeline
    : events.map((event, position) => ({
      index: event.index ?? position,
      timestamp: event.timestamp,
      type: event.type,
      method: event.method,
      name: event.name,
      preview: previewFor(event)
    }));

  return { session, summary, timeline, events, decisions: resolveDecisionEntries(root, events) };
}

function eventValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { content: value };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function indexValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function previewFor(event: Record<string, unknown>): string {
  const explicitPreview = stringValue(event.preview);
  if (explicitPreview !== undefined) {
    return truncate(explicitPreview, 220);
  }

  const candidate = firstDefined(event.error, event.content, event.result, event.name, event.method, event.type);
  return truncate(displayValue(candidate), 220);
}

function orderedEventTypes(eventCounts: Record<string, unknown>): string[] {
  const known = KNOWN_EVENT_TYPES.filter((type) => Object.prototype.hasOwnProperty.call(eventCounts, type));
  const other = Object.keys(eventCounts)
    .filter((type) => !KNOWN_EVENT_TYPES.includes(type as typeof KNOWN_EVENT_TYPES[number]))
    .sort();
  return [...known, ...other];
}

function markdownRow(label: string, value: unknown): string {
  return `| ${escapeMarkdownCell(label)} | ${escapeMarkdownCell(displayValue(value))} |`;
}

function markdownCell(value: unknown): string {
  return ` ${escapeMarkdownCell(displayValue(value))} `;
}

function escapeMarkdownCell(value: unknown): string {
  return displayValue(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, '<br>')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`');
}

function markdownJsonBlock(value: unknown): string {
  const json = stringifyJson(value, 2);
  const longestBacktickRun = Array.from(json.matchAll(/`+/g), (match) => match[0].length)
    .reduce((longest, length) => Math.max(longest, length), 0);
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}json\n${json}\n${fence}`;
}

function displayValue(value: unknown): string {
  if (value === undefined) {
    return '(none)';
  }
  if (typeof value === 'string') {
    return value;
  }
  return stringifyJson(value, 0);
}

function stringifyJson(value: unknown, space: number): string {
  try {
    return JSON.stringify(value, null, space) ?? 'null';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(`[Unserializable export: ${message}]`);
  }
}

function stringifyJsonForScript(value: unknown): string {
  return stringifyJson(value, 0)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\u2028/g, '&#8232;')
    .replace(/\u2029/g, '&#8233;');
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

