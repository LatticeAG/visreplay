import { describe, expect, it } from 'vitest';

import {
  parseExportFormat,
  renderDebugViewer,
  renderExport,
  renderHtmlTimeline,
  renderMarkdownReport
} from './render';

describe('render helpers', () => {
  it('parses export format aliases including interop names', () => {
    expect(parseExportFormat('JSON')).toBe('json');
    expect(parseExportFormat('md')).toBe('markdown');
    expect(parseExportFormat('htm')).toBe('html');
    expect(parseExportFormat('otlp')).toBe('otlp');
    expect(parseExportFormat('langfuse')).toBe('langfuse');
    expect(parseExportFormat('langsmith')).toBe('langsmith');
  });

  it('rejects unsupported export formats', () => {
    expect(() => parseExportFormat('pdf')).toThrow('format must be one of');
  });

  it('renders Markdown reports with session summary and event headings', () => {
    const markdown = renderMarkdownReport(createDebugExport());
    expect(markdown).toContain('# VisReplay Debug Report');
    expect(markdown).toContain('### Event 1: `output`');
    expect(markdown).toContain('## Decisions');
    expect(markdown).toContain('_No decision records were captured._');
  });

  it('HTML-escapes session names in the static timeline', () => {
    const html = renderHtmlTimeline(createDebugExport({ sessionName: '<script>alert(1)</script>' }));
    expect(html).toContain('VisReplay timeline');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('keeps JSON export pretty-printed and writes a decision-ready viewer shell', () => {
    const debugExport = createDebugExport();
    expect(renderExport(debugExport, 'json')).toBe(`${JSON.stringify(debugExport, null, 2)}\n`);
    const viewer = renderDebugViewer(debugExport);
    expect(viewer).toContain('data-filter="tool_call"');
    expect(viewer).toContain('data-filter="decision"');
    expect(viewer).toContain('Why this step');
    expect(viewer).toContain('Full recorded event');
  });
});

function createDebugExport(session: { sessionName?: string } = {}): Record<string, unknown> {
  return {
    $schema: 'visreplay/debug/1.0',
    session: {
      sessionId: 'ses_render',
      sessionName: session.sessionName ?? 'render-test',
      agentType: 'test-agent',
      startedAt: '2026-07-21T09:00:00.000Z'
    },
    summary: {
      eventCount: 2,
      eventCounts: {
        input: 1,
        reasoning: 0,
        tool_call: 0,
        tool_result: 0,
        output: 1,
        error: 0
      },
      errorCount: 0
    },
    timeline: [
      {
        index: 0,
        timestamp: '2026-07-21T09:00:00.000Z',
        type: 'input',
        method: 'run',
        preview: 'deploy staging'
      },
      {
        index: 1,
        timestamp: '2026-07-21T09:00:01.000Z',
        type: 'output',
        method: 'run',
        preview: 'done'
      }
    ],
    events: [
      {
        eventId: 'evt_0',
        index: 0,
        timestamp: '2026-07-21T09:00:00.000Z',
        type: 'input',
        method: 'run',
        content: ['deploy staging']
      },
      {
        eventId: 'evt_1',
        index: 1,
        timestamp: '2026-07-21T09:00:01.000Z',
        type: 'output',
        method: 'run',
        content: 'done'
      }
    ]
  };
}
