'use strict';

// Semantic wall detection — the one judgment the userscript is contractually
// forbidden to make (FROZEN-INTERFACE: "采集 + 执行 + 汇报,不判断"). It posts
// raw facts — attentionRequired + extracted content — and this module decides
// whether that is a genuine wall. A read is only 'blocked' when the wall left
// no content behind; a page with a visible sign-in upsell (IEEE "Save Your
// Search") still has complete content and must report 'completed'.

// True when an extract result carries no usable content.
function contentEmpty(data) {
  const values = Object.values(data || {});
  if (!values.length) return true;
  return values.every((value) => (Array.isArray(value) ? value.length === 0 : !String(value || '').trim()));
}

// Map a finished bridge job to the semantic status the MCP client sees.
//   - 'error' relays as-is.
//   - Non-terminal transport states (queued/claimed) relay as-is.
//   - 'blocked' is a legacy transport value from pre-1.0.3 userscripts — it is
//     recomputed here too, never relayed verbatim.
//   - A finished extract is 'blocked' only when a wall left the content empty;
//     any non-extract action with a wall in view also reports 'blocked'.
function semanticStatus(job) {
  if (job.status === 'error') return 'error';
  if (job.status !== 'completed' && job.status !== 'blocked') return job.status;
  const result = job.result || {};
  const isWall = !!result.attentionRequired && (job.type !== 'extract' || contentEmpty(result.data));
  return isWall ? 'blocked' : 'completed';
}

module.exports = { contentEmpty, semanticStatus };
