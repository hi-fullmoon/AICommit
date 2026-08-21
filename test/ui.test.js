import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatReasoningForTerminal, formatReasoningPanel, getReasoningView,
} from '../src/ui.js';

test('formatReasoningForTerminal strips terminal control sequences', () => {
  const raw = '\x1b[31mdanger\x1b[0m\nkeep\x00text\x1b]0;title\x07';
  assert.equal(formatReasoningForTerminal(raw), 'danger\nkeeptext');
});

test('formatReasoningForTerminal caps output while preserving both ends', () => {
  const raw = 'START-' + 'x'.repeat(500) + '-END';
  const out = formatReasoningForTerminal(raw, 120);
  assert.ok(out.length <= 120);
  assert.ok(out.startsWith('START-'));
  assert.ok(out.endsWith('-END'));
  assert.match(out, /reasoning truncated/);
  assert.equal(formatReasoningForTerminal(raw, 10).length, 10);
});

test('reasoning preview is limited to two wrapped terminal lines', () => {
  const reasoning = '思'.repeat(40);
  const collapsed = getReasoningView(reasoning, { columns: 30 });
  const expanded = getReasoningView(reasoning, { columns: 30, expanded: true });

  assert.equal(collapsed.text.split('\n').length, 2);
  assert.ok(collapsed.truncated);
  assert.ok(collapsed.totalLines > 2);
  assert.equal(expanded.text, reasoning.match(/.{1,12}/gu).join('\n'));
  assert.equal(expanded.truncated, false);
});

test('reasoning panel advertises Ctrl+O expand and collapse states', () => {
  const reasoning = Array.from({ length: 4 }, (_, i) => `line ${i + 1}`).join('\n');

  assert.match(formatReasoningPanel(reasoning, { columns: 80 }), /◇ Thinking/);
  assert.match(formatReasoningPanel(reasoning, { columns: 80 }), /Ctrl\+O expand/);
  assert.doesNotMatch(formatReasoningPanel(reasoning, { columns: 80 }), /line 2/);
  assert.match(formatReasoningPanel(reasoning, { columns: 80 }), /line 3/);
  assert.match(formatReasoningPanel(reasoning, { columns: 80 }), /line 4/);
  assert.match(formatReasoningPanel(reasoning, { columns: 80, expanded: true }), /Ctrl\+O collapse/);
  assert.match(formatReasoningPanel(reasoning, { columns: 80, expanded: true }), /line 3/);
});

test('empty reasoning uses the Thinking title', () => {
  assert.match(formatReasoningPanel(''), /◇ Thinking unavailable/);
});

test('expanded reasoning is paged to stay within the terminal viewport', () => {
  const reasoning = Array.from({ length: 30 }, (_, i) => `step ${i + 1}`).join('\n');
  const firstPage = getReasoningView(reasoning, {
    columns: 80, expanded: true, maxExpandedLines: 8,
  });
  const lastPage = getReasoningView(reasoning, {
    columns: 80, expanded: true, maxExpandedLines: 8, offset: 999,
  });

  assert.equal(firstPage.text.split('\n').length, 8);
  assert.equal(firstPage.startLine, 1);
  assert.equal(firstPage.endLine, 8);
  assert.equal(lastPage.text.split('\n').length, 8);
  assert.equal(lastPage.startLine, 23);
  assert.equal(lastPage.endLine, 30);
  assert.match(formatReasoningPanel(reasoning, {
    columns: 80, expanded: true, maxExpandedLines: 8,
  }), /1-8\/30 · PgUp\/PgDn/);
});
