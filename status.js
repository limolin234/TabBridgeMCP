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

// Interact-snapshot staleness guard. A click-by-index resolves against the
// snapshot the MCP server cached at browser_read(interact) time; if the page
// re-rendered since then the index points at the wrong element. The guard
// refuses to act on a snapshot that is (a) gone, (b) for a different URL, or
// (c) older than maxAgeMs, so the caller re-reads instead of misfiring.
function snapshotStale(snapshot, tabUrl, maxAgeMs) {
  if (!snapshot) return { ok: false, reason: 'No interact snapshot. Call browser_read with mode "interact" first.' };
  if (tabUrl !== snapshot.url) return { ok: false, reason: 'Page changed since the interact snapshot; re-read interact.' };
  const captured = Date.parse(snapshot.capturedAt || '');
  if (!Number.isFinite(captured)) return { ok: false, reason: 'Interact snapshot has no valid capture time; re-read interact.' };
  const ageMs = Date.now() - captured;
  if (ageMs > maxAgeMs) return { ok: false, reason: `Interact snapshot is stale (${Math.round(ageMs / 1000)}s old, max ${Math.round(maxAgeMs / 1000)}s); re-read interact before acting.` };
  return { ok: true };
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

module.exports = { contentEmpty, semanticStatus, snapshotStale };
