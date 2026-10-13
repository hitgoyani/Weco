'use strict';

const PRIVACY = globalThis.LocalWebQaPrivacy;
const $ = id => document.getElementById(id);
const BASELINE_PREFIXES = ['baseline:v2:', 'baseline:v1:', 'baseline:v1-fallback:'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function setStatus(message, type = '') {
  $('statusLine').textContent = message;
  $('statusLine').className = `status-line ${type}`.trim();
}

function isBaselineKey(key) {
  return BASELINE_PREFIXES.some(prefix => key.startsWith(prefix));
}

async function loadBaselines() {
  $('baselineList').innerHTML = '';
  $('emptyState').hidden = true;
  try {
    const data = await chrome.storage.local.get(null);
    const entries = Object.entries(data)
      .filter(([key, value]) => isBaselineKey(key) && value && typeof value === 'object')
      .sort((a, b) => String(b[1].savedAt || '').localeCompare(String(a[1].savedAt || '')));
    $('emptyState').hidden = entries.length > 0;
    for (const [key, item] of entries) {
      const count = Number(item.totalFindings ?? item.findings?.length ?? 0);
      const card = document.createElement('article');
      card.className = 'baseline-card';
      card.innerHTML = `<div class="baseline-title">${escapeHtml(PRIVACY?.safeTextForSharing(item.title || 'Untitled page') || 'Untitled page')}</div>
        <div class="baseline-url">${escapeHtml(PRIVACY?.safeUrlForSharing(item.url) || '(URL omitted)')}</div>
        <div class="baseline-meta">Saved ${escapeHtml(item.savedAt ? new Date(item.savedAt).toLocaleString() : 'at an unknown time')} · ${count} captured finding(s)${item.truncated ? ' · incomplete report' : ''}</div>
        <div class="baseline-actions"><button class="secondary-btn danger-btn" data-delete="${escapeHtml(key)}">Delete baseline</button></div>`;
      $('baselineList').appendChild(card);
    }
    setStatus(`${entries.length} saved baseline(s).`, 'success');
  } catch (error) {
    setStatus('Could not read local extension storage.', 'error');
  }
}

$('refreshBtn').addEventListener('click', loadBaselines);
$('baselineList').addEventListener('click', async event => {
  const button = event.target.closest('button[data-delete]');
  if (!button) return;
  const key = button.dataset.delete;
  if (!key || !isBaselineKey(key)) return;
  try {
    await chrome.storage.local.remove(key);
    setStatus('Baseline deleted.', 'success');
    await loadBaselines();
  } catch (_) {
    setStatus('Could not delete this baseline.', 'error');
  }
});
$('deleteAllBtn').addEventListener('click', async () => {
  try {
    const data = await chrome.storage.local.get(null);
    const keys = Object.keys(data).filter(isBaselineKey);
    if (!keys.length) { setStatus('There are no saved baselines to delete.'); return; }
    await chrome.storage.local.remove(keys);
    setStatus(`${keys.length} baseline(s) deleted.`, 'success');
    await loadBaselines();
  } catch (_) {
    setStatus('Could not delete saved baselines.', 'error');
  }
});

loadBaselines();
