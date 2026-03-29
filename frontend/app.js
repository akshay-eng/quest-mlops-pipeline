// =============================================================================
// Quest Diagnostics — WINGS Platform
// Incidents tab: Node.js backend on port 4000
// Workflows tab: FastAPI backend on port 8000
// =============================================================================

const API_BASE         = 'http://localhost:8002';  // alertmanager Flask backend
const WF_API_BASE      = 'http://localhost:8000';  // FastAPI backend
const POLL_INTERVAL    = 10000;
const WF_POLL_INTERVAL = 15000;
const OS_POLL_INTERVAL = 60000;   // OpenScale — poll every 60s (API is slower)
const EV_POLL_INTERVAL = 300000;  // Evidently — poll every 5 min (matches CronJob)

let allAlerts      = [];
let currentAlertId = null;
let chatThreadId   = null;

let allRuns        = [];
let resolveRunId   = null;
let resolveAbort   = null;   // AbortController for the SSE fetch
let activeTab      = 'incidents';

let allDeployments    = [];
let currentDeployment = null;

// ---------------------------------------------------------------------------
// INCIDENT METADATA
// ---------------------------------------------------------------------------
const INCIDENT_MAP = {
  pipeline_failure: {
    displayTitle: 'Pipeline Failure Investigation',
    category:     'Pipeline',
    suggestedActions: [
      'Capture pod logs before next restart: kubectl logs -n <namespace> <pod> --previous',
      'Check recent pipeline configuration or ConfigMap changes',
      'Verify connectivity to upstream data sources from within the cluster',
      'Review deployment rollout history: kubectl rollout history deployment/<name>',
    ],
  },
  api_connection_issue: {
    displayTitle: 'API Connection Issue',
    category:     'Connectivity',
    suggestedActions: [
      'Verify the MyQuest API endpoint URL in the service ConfigMap',
      'Check API authentication tokens — they may have rotated or expired',
      'Test network reachability from the pod using a debug container',
      'Review recent API changelog for breaking endpoint changes',
    ],
  },
  openscale_outage: {
    displayTitle: 'OpenScale Service Outage',
    category:     'Service Availability',
    suggestedActions: [
      'Inspect pod status: kubectl describe pod -n <namespace> <pod>',
      'Verify OpenScale backend database connectivity',
      'Check pod resource limits — OOMKill may be causing restarts',
      'Escalate to OpenScale platform team if unresolvable within SLA',
    ],
  },
  evaluation_failure: {
    displayTitle: 'Evaluation Failure',
    category:     'Model Evaluation',
    suggestedActions: [
      'Review evaluation job logs: kubectl logs -n <namespace> -l app=quest-evaluation-job',
      'Verify evaluation dataset availability and schema conformance',
      'Check data quality validation rules for recent changes',
      'Ensure pipeline has produced fresh output data for the evaluation window',
    ],
  },
  data_quality_issue: {
    displayTitle: 'Data Quality Issue',
    category:     'Data Integrity',
    suggestedActions: [
      'Run schema validation checks against the latest pipeline output',
      'Compare recent data samples against the expected format specification',
      'Check upstream data source for format or schema changes',
      'Review recent data transformation logic for regressions',
    ],
  },
};

function resolveIncident(alert) {
  const type = alert.incident_type || '';
  return INCIDENT_MAP[type] || {
    displayTitle:     alert.title || alert.alertname || 'Incident',
    category:         'General',
    suggestedActions: [
      'Review pod logs for the affected workload',
      'Check recent deployments and configuration changes',
      'Verify service health and dependencies',
    ],
  };
}

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  fetchAlerts();
  setInterval(fetchAlerts, POLL_INTERVAL);
  fetchWorkflows();
  setInterval(fetchWorkflows, WF_POLL_INTERVAL);
  fetchDeployments();
  setInterval(fetchDeployments, OS_POLL_INTERVAL);
  fetchEvidently();
  setInterval(fetchEvidently, EV_POLL_INTERVAL);
});

// ---------------------------------------------------------------------------
// TAB SWITCHING
// ---------------------------------------------------------------------------
function switchTab(tab) {
  activeTab = tab;

  document.getElementById('tabIncidents').classList.toggle('active',  tab === 'incidents');
  document.getElementById('tabWorkflows').classList.toggle('active',  tab === 'workflows');
  document.getElementById('tabModels').classList.toggle('active',     tab === 'models');
  document.getElementById('tabEvidently').classList.toggle('active',  tab === 'evidently');
  document.getElementById('tabSettings').classList.toggle('active',   tab === 'settings');

  document.getElementById('incidentsView').style.display  = tab === 'incidents'  ? '' : 'none';
  document.getElementById('workflowsView').style.display  = tab === 'workflows'  ? '' : 'none';
  document.getElementById('modelsView').style.display     = tab === 'models'     ? '' : 'none';
  document.getElementById('evidentlyView').style.display  = tab === 'evidently'  ? '' : 'none';
  document.getElementById('settingsView').style.display   = tab === 'settings'   ? '' : 'none';

  if (tab === 'workflows') fetchWorkflows();
  if (tab === 'models')    fetchDeployments();
  if (tab === 'evidently') fetchEvidently();
  if (tab === 'settings')  loadSettings();
}

// ---------------------------------------------------------------------------
// FETCH ALERTS
// ---------------------------------------------------------------------------
async function fetchAlerts() {
  try {
    const res = await fetch(`${API_BASE}/api/alerts`);
    if (!res.ok) throw new Error('Server error');
    allAlerts = await res.json();
    updateStats(allAlerts);
    renderAlerts(allAlerts);
    setOnline(true);
    const firing = allAlerts.filter(a => a.status === 'active').length;
    const badge  = document.getElementById('tabIncidentsBadge');
    badge.textContent = firing;
    badge.className   = 'tab-badge' + (firing > 0 ? ' tab-badge-red' : '');
  } catch {
    setOnline(false);
  }
}

function setOnline(_online) { /* indicator removed */ }

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------
function updateStats(alerts) {
  document.getElementById('statTotal').textContent       = alerts.length;
  document.getElementById('statCritical').textContent    = alerts.filter(a => a.severity === 'critical').length;
  document.getElementById('statWarning').textContent     = alerts.filter(a => a.severity === 'warning').length;
  document.getElementById('statOccurrences').textContent = alerts.reduce((s, a) => s + (a.count || 1), 0);
}

// ---------------------------------------------------------------------------
// RENDER ALERTS
// ---------------------------------------------------------------------------
function renderAlerts(alerts) {
  const list  = document.getElementById('alertList');
  const empty = document.getElementById('emptyState');

  if (alerts.length === 0) {
    list.innerHTML = '';
    list.appendChild(empty);
    return;
  }
  if (empty.parentNode === list) list.removeChild(empty);
  list.innerHTML = alerts.map(buildRow).join('');
}

function buildRow(alert) {
  const sev   = alert.severity || 'warning';
  const count = alert.count || 1;
  const multi = count > 1;
  const name  = alert.alertname || alert.title || 'Alert';
  const desc  = alert.description || '';
  const ts    = alert.starts_at || '';

  return `
<div class="alert-row" onclick="openAlertDetail('${escHtml(alert.id)}')">
  <div class="col-severity">
    <span class="badge badge-${sev}">${sev}</span>
  </div>
  <div class="col-title">
    <span class="alert-name">${escHtml(name)}</span>
    <span class="alert-desc">${escHtml(desc.slice(0, 120))}${desc.length > 120 ? '…' : ''}</span>
  </div>
  <div class="col-service">${escHtml(alert.namespace || '—')}</div>
  <div class="col-namespace">${escHtml(alert.pod || alert.container || '—')}</div>
  <div class="col-occurrences ${multi ? 'high' : ''}">${count}</div>
  <div class="col-time">${formatRelative(ts)}</div>
  <div class="col-status">
    <span class="badge badge-critical">
      <span class="status-dot firing"></span>Firing
    </span>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// FILTER ALERTS
// ---------------------------------------------------------------------------
function filterAlerts() {
  const q    = document.getElementById('searchInput').value.toLowerCase();
  const sev  = document.getElementById('severityFilter').value;
  const type = document.getElementById('typeFilter').value;

  const filtered = allAlerts.filter(a => {
    const matchQ = !q ||
      (a.alertname || '').toLowerCase().includes(q) ||
      (a.title || '').toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.namespace || '').toLowerCase().includes(q) ||
      (a.pod || '').toLowerCase().includes(q);
    return matchQ &&
      (!sev  || a.severity === sev) &&
      (!type || (a.namespace || '') === type);
  });

  renderAlerts(filtered);
}

// ---------------------------------------------------------------------------
// ALERT DETAIL MODAL
// ---------------------------------------------------------------------------
function openAlertDetail(alertId) {
  const alert = allAlerts.find(a => a.id === alertId);
  if (!alert) return;

  currentAlertId = alertId;
  chatThreadId   = null;

  const sev   = alert.severity || 'warning';
  const count = alert.count || 1;
  const name  = alert.alertname || alert.title || 'Alert';

  // Build labels list from the labels object
  const labelRows = Object.entries(alert.labels || {})
    .map(([k, v]) => `<div class="detail-field"><div class="field-label">${escHtml(k)}</div><div class="field-value">${escHtml(v)}</div></div>`)
    .join('');

  document.getElementById('detailTitle').textContent    = escHtml(name);
  document.getElementById('detailSubtitle').textContent = `Alertmanager — Quest Diagnostics K8s`;

  document.getElementById('detailContent').innerHTML = `
    <div class="detail-section">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <span class="badge badge-${sev}">${sev}</span>
        <span class="badge badge-critical"><span class="status-dot firing"></span>Firing</span>
        ${count > 1 ? `<span class="badge badge-neutral">${count} occurrences</span>` : ''}
      </div>
      <div style="font-size:13px;color:var(--text-muted);line-height:1.6">${escHtml(alert.description || '—')}</div>
    </div>

    <div class="detail-section">
      <div class="section-label">Alert Details</div>
      <div class="detail-grid">
        <div class="detail-field">
          <div class="field-label">Namespace</div>
          <div class="field-value">${escHtml(alert.namespace || '—')}</div>
        </div>
        <div class="detail-field">
          <div class="field-label">Pod</div>
          <div class="field-value">${escHtml(alert.pod || '—')}</div>
        </div>
        <div class="detail-field">
          <div class="field-label">Container</div>
          <div class="field-value">${escHtml(alert.container || '—')}</div>
        </div>
        <div class="detail-field">
          <div class="field-label">Started</div>
          <div class="field-value">${formatFull(alert.starts_at)}</div>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="section-label">Occurrences</div>
      <div class="occurrence-block">
        <div class="occurrence-num ${count > 1 ? 'high' : ''}">${count}</div>
        <div class="occurrence-label">times this alert has fired (deduplicated)</div>
      </div>
    </div>

    ${labelRows ? `
    <div class="detail-section">
      <div class="section-label">Labels</div>
      <div class="detail-grid">${labelRows}</div>
    </div>` : ''}

    ${alert.runbook_url ? `
    <div class="detail-section">
      <div class="section-label">Runbook</div>
      <a href="${escHtml(alert.runbook_url)}" target="_blank" class="btn btn-ghost" style="font-size:12px">Open Runbook ↗</a>
    </div>` : ''}
  `;

  document.getElementById('detailModal').querySelector('.modal-footer')?.remove();
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `
    <button class="btn btn-ai" onclick="closeDetail(); openAlertChat('${escHtml(alert.id)}')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      Investigate &amp; Resolve with AI
    </button>
    <button class="btn btn-ghost" onclick="dismissAlert('${escHtml(alert.id)}')">Dismiss</button>
  `;
  document.getElementById('detailModal').appendChild(footer);
  document.getElementById('detailOverlay').classList.add('open');
}

function closeDetail() {
  document.getElementById('detailOverlay').classList.remove('open');
  document.getElementById('detailModal').querySelector('.modal-footer')?.remove();
}

function closeDetailModal(e) {
  if (e.target === document.getElementById('detailOverlay')) closeDetail();
}

async function dismissAlert(alertId) {
  try {
    await fetch(`${API_BASE}/api/alerts/${alertId}/cancel`, { method: 'POST' });
    closeDetail();
    fetchAlerts();
  } catch (err) {
    console.error('Dismiss failed:', err);
  }
}

// ---------------------------------------------------------------------------
// AI CHAT MODAL — Alert investigation
// Agent: Quest SDLC Remediation Agent (2747d3ab-754e-4d03-85c2-1a023019ec6e)
// ---------------------------------------------------------------------------
const REMEDIATION_AGENT_ID = '2747d3ab-754e-4d03-85c2-1a023019ec6e';

function openAlertChat(alertId) {
  const alert = allAlerts.find(a => a.id === alertId);
  currentAlertId = alertId;
  chatThreadId   = null;

  const name  = alert ? (alert.alertname || alert.title || 'Alert') : 'Alert';
  const sev   = alert ? (alert.severity || 'warning').toUpperCase() : '';
  const count = alert ? (alert.count || 1) : 1;

  document.getElementById('chatAlertName').textContent = name;

  const ctx = document.getElementById('chatIncidentCtx');
  if (alert) {
    ctx.textContent = `${sev}  ·  ${count} occurrence(s)  ·  ${alert.namespace || '—'}  ·  ${alert.pod || '—'}`;
    ctx.classList.add('visible');
  } else {
    ctx.classList.remove('visible');
  }

  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('chatOverlay').classList.add('open');

  // Auto-investigate immediately — send alert context as first message
  if (alert) {
    const autoPrompt =
      `Investigate this Kubernetes alert and provide root cause analysis and remediation steps:\n\n` +
      `Alert: ${alert.alertname || alert.title}\n` +
      `Severity: ${alert.severity || 'warning'}\n` +
      `Namespace: ${alert.namespace || '—'}\n` +
      `Pod: ${alert.pod || '—'}\n` +
      `Container: ${alert.container || '—'}\n` +
      `Occurrences: ${alert.count || 1}\n` +
      `Description: ${alert.description || '—'}\n` +
      `Labels: ${JSON.stringify(alert.labels || {})}`;

    _streamAgentResponse(autoPrompt, true);
  }
}

// Keep backward compat
function openChat(alertId) { openAlertChat(alertId); }

function closeChat() {
  document.getElementById('chatOverlay').classList.remove('open');
}

function closeChatModal(e) {
  if (e.target === document.getElementById('chatOverlay')) closeChat();
}

async function _streamAgentResponse(prompt, isAuto = false) {
  const typingEl = addTypingIndicator();
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('chatInput').disabled = true;

  try {
    const res = await fetch(`${WF_API_BASE}/api/investigate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        message:   prompt,
        thread_id: chatThreadId || null,
        agent_id:  REMEDIATION_AGENT_ID,
      }),
    });

    if (!res.ok || !res.body) throw new Error('Stream unavailable');
    if (typingEl._interval) clearInterval(typingEl._interval);
    typingEl.remove();

    const msgEl = document.createElement('div');
    msgEl.className = 'msg msg-ai';
    appendMsg(msgEl);

    const reader   = res.body.getReader();
    const decoder  = new TextDecoder();
    let   buf      = '';
    let   fullText = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const chunk = JSON.parse(jsonStr);
          if (chunk.thread_id) chatThreadId = chunk.thread_id;
          if (chunk.text) {
            fullText += chunk.text;
            msgEl.innerHTML = renderMarkdown(fullText);
            document.getElementById('chatMessages').scrollTop =
              document.getElementById('chatMessages').scrollHeight;
          }
        } catch { /* ignore */ }
      }
    }

    if (!fullText) msgEl.innerHTML = renderMarkdown('No response received. Please try again.');

  } catch (err) {
    if (typingEl._interval) clearInterval(typingEl._interval);
    typingEl.remove();
    addAIMessage('Unable to reach the AI backend. Ensure alertmanager.py is running on port 8002.');
    console.error('Chat error:', err);
  } finally {
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('chatInput').disabled = false;
    document.getElementById('chatInput').focus();
  }
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const msg   = input.value.trim();
  if (!msg) return;

  input.value = '';
  addUserMessage(msg);
  await _streamAgentResponse(msg);
}

// ---------------------------------------------------------------------------
// MESSAGE HELPERS
// ---------------------------------------------------------------------------
function addUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  el.textContent = text;
  appendMsg(el);
}

function addAIMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-ai';
  el.innerHTML = renderMarkdown(text);
  appendMsg(el);
}

const _investigationSteps = [
  'Investigating...',
  'Investigating......',
  'Investigating.........',
];

function addTypingIndicator() {
  const el = document.createElement('div');
  el.className = 'typing-indicator investigation-indicator';

  const textEl = document.createElement('span');
  textEl.className = 'investigation-text';
  textEl.textContent = _investigationSteps[0];
  el.appendChild(textEl);

  let step = 0;
  el._interval = setInterval(() => {
    step = (step + 1) % _investigationSteps.length;
    textEl.textContent = _investigationSteps[step];
  }, 1800);

  appendMsg(el);
  return el;
}

const _origTypingRemove = HTMLElement.prototype.remove;
// Patch remove to clear the interval
const _patchedRemove = function() {
  if (this._interval) clearInterval(this._interval);
  _origTypingRemove.call(this);
};

function appendMsg(el) {
  const c = document.getElementById('chatMessages');
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function renderMarkdown(text) {
  return text
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
}

// =============================================================================
// GITHUB WORKFLOWS TAB
// =============================================================================

// ---------------------------------------------------------------------------
// FETCH WORKFLOW RUNS
// ---------------------------------------------------------------------------
async function fetchWorkflows() {
  try {
    const res = await fetch(`${WF_API_BASE}/api/workflows?per_page=20`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allRuns = await res.json();
    updateWfStats(allRuns);
    renderWorkflows(allRuns);

    // Update badge — count failures
    const failCount = allRuns.filter(r => r.conclusion === 'failure').length;
    const badge = document.getElementById('tabWorkflowsBadge');
    badge.textContent = failCount;
    badge.className   = 'tab-badge' + (failCount > 0 ? ' tab-badge-red' : '');
  } catch (err) {
    console.warn('Workflows fetch failed:', err.message);
    if (allRuns.length === 0) showWfEmpty('Backend offline — start the FastAPI server on port 8000');
  }
}

// ---------------------------------------------------------------------------
// WF STATS
// ---------------------------------------------------------------------------
function updateWfStats(runs) {
  const failed    = runs.filter(r => r.conclusion === 'failure').length;
  const running   = runs.filter(r => r.status === 'in_progress').length;
  const completed = runs.filter(r => r.status === 'completed').length;
  const succeeded = runs.filter(r => r.conclusion === 'success').length;
  const rate      = completed > 0 ? Math.round((succeeded / completed) * 100) : 0;

  document.getElementById('wfStatTotal').textContent   = runs.length;
  document.getElementById('wfStatFailed').textContent  = failed;
  document.getElementById('wfStatRunning').textContent = running;
  document.getElementById('wfStatRate').textContent    = completed > 0 ? `${rate}%` : '—';
}

// ---------------------------------------------------------------------------
// FILTER WORKFLOWS
// ---------------------------------------------------------------------------
function filterWorkflows() {
  const q      = document.getElementById('wfSearchInput').value.toLowerCase();
  const status = document.getElementById('wfStatusFilter').value;
  const branch = document.getElementById('wfBranchFilter').value;

  const filtered = allRuns.filter(r => {
    const matchQ = !q ||
      (r.name || '').toLowerCase().includes(q) ||
      (r.branch || '').toLowerCase().includes(q) ||
      (r.commit_sha || '').toLowerCase().includes(q);
    const matchStatus = !status || r.conclusion === status || r.status === status;
    const matchBranch = !branch || r.branch === branch;
    return matchQ && matchStatus && matchBranch;
  });

  renderWorkflows(filtered);
}

// ---------------------------------------------------------------------------
// RENDER WORKFLOW CARDS
// ---------------------------------------------------------------------------
function renderWorkflows(runs) {
  const grid = document.getElementById('wfGrid');

  if (!runs || runs.length === 0) {
    showWfEmpty('No workflow runs found. Trigger a run in GitHub to see it here.');
    return;
  }

  grid.innerHTML = runs.map(buildWfCard).join('');
}

function showWfEmpty(msg) {
  document.getElementById('wfGrid').innerHTML = `
    <div class="wf-empty" style="grid-column:1/-1">
      <div class="empty-icon-wrap">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
        </svg>
      </div>
      <div class="empty-title">${escHtml(msg)}</div>
    </div>`;
}

function wfStatusClass(run) {
  if (run.status === 'in_progress') return 'wf-card-running';
  if (run.conclusion === 'failure')  return 'wf-card-failure';
  if (run.conclusion === 'success')  return 'wf-card-success';
  return 'wf-card-neutral';
}

function wfStatusBadge(run) {
  if (run.status === 'in_progress')
    return `<span class="badge badge-blue"><span class="wf-spin-dot"></span>Running</span>`;
  if (run.conclusion === 'failure')
    return `<span class="badge badge-critical"><span class="status-dot firing"></span>Failed</span>`;
  if (run.conclusion === 'success')
    return `<span class="badge badge-success"><span class="status-dot resolved"></span>Passed</span>`;
  if (run.conclusion === 'cancelled')
    return `<span class="badge badge-neutral">Cancelled</span>`;
  return `<span class="badge badge-neutral">${escHtml(run.status || '—')}</span>`;
}

function wfDuration(run) {
  if (!run.created_at || !run.updated_at) return '—';
  const ms = new Date(run.updated_at) - new Date(run.created_at);
  if (ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${s}s`;
}

function buildWfCard(run) {
  const isFailed = run.conclusion === 'failure';
  const duration = wfDuration(run);

  // Short workflow name (strip "Quest MLOps — " prefix for brevity if present)
  const shortName = (run.name || 'Workflow').replace(/^Quest MLOps\s*[—–-]\s*/i, '');

  const resolveBtn = isFailed ? `
    <button class="btn-resolve" onclick="event.stopPropagation(); openResolve(${run.id}, '${escHtml(run.name || '')}')">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:5px">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      Resolve with WINGS
    </button>` : '';

  const viewLink = run.html_url ? `
    <a class="wf-view-link" href="${escHtml(run.html_url)}" target="_blank" onclick="event.stopPropagation()">
      View on GitHub ↗
    </a>` : '';

  return `
<div class="wf-card ${wfStatusClass(run)}" onclick="openWfDetail(${run.id})" style="cursor:pointer">
  <div class="wf-card-header">
    ${wfStatusBadge(run)}
    <span class="wf-run-num">#${run.id}</span>
  </div>

  <div class="wf-card-name" title="${escHtml(run.name || '')}">
    ${escHtml(shortName)}
  </div>

  <div class="wf-card-meta">
    <span class="wf-meta-item">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/>
        <circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
      </svg>
      <span class="wf-meta-val">${escHtml(run.branch || '—')}</span>
    </span>
    <span class="wf-meta-item">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
      ${formatRelative(run.created_at)}
    </span>
    <span class="wf-meta-item">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
      </svg>
      <span class="wf-meta-val" style="font-family:monospace">${escHtml(run.commit_sha || '—')}</span>
    </span>
  </div>

  <div class="wf-card-footer">
    <span class="wf-duration">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
      ${duration}
    </span>
    <div style="display:flex;align-items:center;gap:10px">
      ${viewLink}
      ${resolveBtn}
    </div>
  </div>
</div>`;
}

// =============================================================================
// WINGS RESOLVE MODAL — SSE resolution log stream
// =============================================================================

function openResolve(runId, runName) {
  resolveRunId = runId;

  // Abort any previous stream
  if (resolveAbort) { resolveAbort.abort(); resolveAbort = null; }

  document.getElementById('resolveRunName').textContent =
    `Run #${runId}${runName ? ' · ' + runName.replace(/^Quest MLOps\s*[—–-]\s*/i, '') : ''}`;

  // Meta strip — find the run object
  const run = allRuns.find(r => r.id === runId);
  const meta = document.getElementById('resolveMetaStrip');
  if (run) {
    meta.innerHTML = `
      <span class="resolve-meta-item">Branch: <strong>${escHtml(run.branch || '—')}</strong></span>
      <span class="resolve-meta-sep">·</span>
      <span class="resolve-meta-item">Commit: <strong>${escHtml(run.commit_sha || '—')}</strong></span>
      <span class="resolve-meta-sep">·</span>
      <span class="resolve-meta-item">Triggered: <strong>${formatRelative(run.created_at)}</strong></span>
    `;
    meta.style.display = 'flex';
  } else {
    meta.style.display = 'none';
  }

  // Reset log
  document.getElementById('resolveLog').innerHTML = '';
  document.getElementById('resolveStatusText').textContent = 'Starting WINGS agent...';
  document.getElementById('resolveStatusDot').className   = 'resolve-status-dot running';
  document.getElementById('resolveDoneBtn').style.display = 'none';
  document.getElementById('resolveCloseBtn').disabled     = true;

  document.getElementById('resolveOverlay').classList.add('open');

  // Start streaming
  startResolveStream(runId);
}

// =============================================================================
// WORKFLOW DETAIL MODAL
// =============================================================================
let _wfDetailRun = null;

async function openWfDetail(runId) {
  _wfDetailRun = allRuns.find(r => r.id === runId) || { id: runId };
  const run = _wfDetailRun;
  const isFailed = run.conclusion === 'failure';

  // Populate static fields immediately
  document.getElementById('wfDetailTitle').textContent =
    (run.name || 'Workflow Run').replace(/^Quest MLOps\s*[—–-]\s*/i, '');
  document.getElementById('wfDetailStatusBadge').innerHTML = wfStatusBadge(run);
  document.getElementById('wfDetailMeta').innerHTML = `
    <span>Run <strong>#${run.id}</strong></span>
    <span class="wf-sep">·</span>
    <span>Branch <strong>${escHtml(run.branch || '—')}</strong></span>
    <span class="wf-sep">·</span>
    <span>Commit <code>${escHtml(run.commit_sha || '—')}</code></span>
    <span class="wf-sep">·</span>
    <span>${formatRelative(run.created_at)}</span>
  `;

  document.getElementById('wfDetailGhLink').href = run.html_url || '#';
  const resolveBtn = document.getElementById('wfDetailResolveBtn');
  resolveBtn.style.display = isFailed ? '' : 'none';

  document.getElementById('wfDetailBody').innerHTML =
    `<div class="os-detail-loading"><div class="os-loading-spinner"></div>Loading jobs…</div>`;
  document.getElementById('wfDetailOverlay').classList.add('open');

  // Fetch full detail (jobs + steps)
  try {
    const res = await fetch(`${WF_API_BASE}/api/workflows/${runId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = await res.json();
    _wfDetailRun = { ...run, ...detail };
    renderWfDetail(_wfDetailRun);
  } catch (err) {
    document.getElementById('wfDetailBody').innerHTML =
      `<div class="os-detail-loading" style="color:var(--critical)">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

function renderWfDetail(run) {
  const steps  = run.steps || [];
  const failed = steps.filter(s => s.conclusion === 'failure');
  const total  = steps.length;
  const passed = steps.filter(s => s.conclusion === 'success').length;

  // Group steps into jobs (steps have sequential numbers; we treat the whole list as one job for now
  // but the backend groups by job already — steps is flat across all jobs)
  // Build job sections by detecting job boundaries via step number resets
  const jobs = _groupStepsIntoJobs(steps);

  const summaryHtml = `
    <div class="wf-summary-strip">
      <div class="wf-sum-item">
        <span class="wf-sum-icon ok">✓</span>
        <span><strong>${passed}</strong> passed</span>
      </div>
      <div class="wf-sum-item">
        <span class="wf-sum-icon ${failed.length > 0 ? 'err' : 'ok'}">${failed.length > 0 ? '✗' : '✓'}</span>
        <span><strong>${failed.length}</strong> failed</span>
      </div>
      <div class="wf-sum-item">
        <span class="wf-sum-label">Total steps</span>
        <strong>${total}</strong>
      </div>
      <div class="wf-sum-item">
        <span class="wf-sum-label">Duration</span>
        <strong>${wfDuration(run)}</strong>
      </div>
    </div>
    ${failed.length > 0 ? `
    <div class="wf-failed-banner">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      Failed step${failed.length > 1 ? 's' : ''}:
      ${failed.map(s => `<strong>${escHtml(s.name)}</strong>`).join(', ')}
    </div>` : ''}`;

  document.getElementById('wfDetailSummary').innerHTML = summaryHtml;

  // Render jobs + steps
  const jobsHtml = jobs.map((job, ji) => {
    const jobFailed  = job.steps.some(s => s.conclusion === 'failure');
    const jobRunning = job.steps.some(s => s.status === 'in_progress');
    const jobIcon    = jobFailed ? '✗' : jobRunning ? '◌' : '✓';
    const jobCls     = jobFailed ? 'err' : jobRunning ? 'run' : 'ok';

    const stepsHtml = job.steps.map(step => {
      const sc   = step.conclusion;
      const icon = sc === 'success' ? '✓' : sc === 'failure' ? '✗' : sc === 'skipped' ? '—' : '◌';
      const cls  = sc === 'success' ? 'ok' : sc === 'failure' ? 'err' : sc === 'skipped' ? 'skip' : 'run';
      const dur  = _stepDuration(step);
      return `
        <div class="wf-step ${sc === 'failure' ? 'wf-step-failed' : ''}">
          <span class="wf-step-icon ${cls}">${icon}</span>
          <span class="wf-step-name">${escHtml(step.name)}</span>
          ${dur ? `<span class="wf-step-dur">${dur}</span>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="wf-job-section">
        <div class="wf-job-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="wf-step-icon ${jobCls}">${jobIcon}</span>
          <span class="wf-job-name">${escHtml(job.name)}</span>
          <svg class="wf-job-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="wf-steps-list">${stepsHtml}</div>
      </div>`;
  }).join('');

  document.getElementById('wfDetailBody').innerHTML =
    jobsHtml || '<div class="os-no-metrics">No step data available</div>';
}

function _groupStepsIntoJobs(steps) {
  // Backend returns steps flat; we re-group by detecting step.number resets
  if (!steps.length) return [];
  const jobs = [];
  let current = { name: 'Job', steps: [] };
  let prevNum = 0;
  for (const s of steps) {
    if (s.number < prevNum && current.steps.length) {
      jobs.push(current);
      current = { name: s.job_name || `Job ${jobs.length + 1}`, steps: [] };
    }
    if (s.job_name && !current.nameSet) {
      current.name    = s.job_name;
      current.nameSet = true;
    }
    current.steps.push(s);
    prevNum = s.number;
  }
  if (current.steps.length) jobs.push(current);
  return jobs;
}

function _stepDuration(step) {
  if (!step.started_at || !step.completed_at) return '';
  const s = Math.round((new Date(step.completed_at) - new Date(step.started_at)) / 1000);
  if (s <= 0) return '';
  return s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
}

function resolveFromDetail() {
  closeWfDetail();
  if (_wfDetailRun) openResolve(_wfDetailRun.id, _wfDetailRun.name || '');
}

function closeWfDetail(e) {
  if (e && e.target !== document.getElementById('wfDetailOverlay')) return;
  document.getElementById('wfDetailOverlay').classList.remove('open');
}

function closeResolve() {
  if (resolveAbort) { resolveAbort.abort(); resolveAbort = null; }
  document.getElementById('resolveOverlay').classList.remove('open');
}

function closeResolveModal(e) {
  if (e.target === document.getElementById('resolveOverlay')) closeResolve();
}

const WORKFLOW_AGENT_ID      = '355ebf69-dee3-45e7-aae3-4fe9e4b9a914';
const MODEL_HEALTH_AGENT_ID  = '9e076c83-4883-4cfe-a33d-f25ac1424b21';

async function startResolveStream(runId) {
  resolveAbort = new AbortController();

  appendLogLine('info', 'WINGS agent initialising — connecting to IBM Watson X Orchestrate...');

  // Build prompt from run context
  const run = allRuns.find(r => r.id === runId) || { id: runId };
  const prompt =
    `Investigate and resolve this failed GitHub Actions workflow run:\n\n` +
    `Run ID: ${runId}\n` +
    `Workflow: ${run.name || '—'}\n` +
    `Branch: ${run.branch || '—'}\n` +
    `Commit: ${run.commit_sha || '—'}\n` +
    `Conclusion: ${run.conclusion || 'failure'}\n` +
    `URL: ${run.html_url || '—'}\n\n` +
    `Please identify the root cause, suggest remediation steps, and if possible trigger a fix.`;

  try {
    const res = await fetch(`${WF_API_BASE}/api/investigate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  resolveAbort.signal,
      body: JSON.stringify({
        message:   prompt,
        thread_id: null,
        agent_id:  WORKFLOW_AGENT_ID,
      }),
    });

    if (!res.ok) {
      appendLogLine('error', `Backend error: HTTP ${res.status}`);
      setResolveDone(false);
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';
    let   fullText = '';

    // Create a live log entry that we update as tokens stream in
    appendLogLine('running', 'Agent is analysing...');
    const logEl = document.getElementById('resolveLog').lastElementChild;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const chunk = JSON.parse(raw);
          if (chunk.text) {
            fullText += chunk.text;
            if (logEl) logEl.querySelector('.log-msg').innerHTML = renderMarkdown(fullText);
            document.getElementById('resolveLog').scrollTop = document.getElementById('resolveLog').scrollHeight;
          }
          if (chunk.done) { setResolveDone(true); return; }
        } catch { /* ignore */ }
      }
    }

    setResolveDone(true);
    return;

  } catch (err) {
    if (err.name === 'AbortError') return;
    appendLogLine('error', `Stream error: ${err.message}`);
    appendLogLine('info', 'Falling back to simulation...');
  }

  // Fallback simulation if backend unreachable
  try {
    const res = await fetch(`${WF_API_BASE}/api/workflows/${runId}/resolve`, {
      method: 'POST',
      signal: resolveAbort.signal,
      headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      appendLogLine('error', `Backend error: HTTP ${res.status}`);
      setResolveDone(false);
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;

        try {
          const evt = JSON.parse(raw);
          appendLogLine(evt.status || 'info', evt.message || '', evt.timestamp);
          if (evt.status === 'done') {
            setResolveDone(true);
            return;
          }
        } catch { /* ignore malformed */ }
      }
    }

    setResolveDone(true);

  } catch (err) {
    if (err.name === 'AbortError') return; // user closed modal
    appendLogLine('error', `Stream error: ${err.message}`);
    setResolveDone(false);
  }
}

function appendLogLine(status, message, timestamp) {
  const log  = document.getElementById('resolveLog');

  // Remove placeholder if present
  const ph = log.querySelector('.log-placeholder');
  if (ph) ph.remove();

  const icons = {
    info:    '·',
    running: '<span class="log-spin">⟳</span>',
    ok:      '✓',
    error:   '✗',
    done:    '✦',
  };

  const ts  = timestamp || new Date().toTimeString().slice(0, 8);
  const ico = icons[status] || '·';

  const line = document.createElement('div');
  line.className = `log-line status-${status}`;
  line.innerHTML =
    `<span class="log-time">${escHtml(ts)}</span>` +
    `<span class="log-icon">${ico}</span>` +
    `<span class="log-msg">${escHtml(message)}</span>`;

  log.appendChild(line);
  log.scrollTop = log.scrollHeight;

  // Live status text
  if (status === 'running') {
    document.getElementById('resolveStatusText').textContent = message.slice(0, 80);
  }
}

function setResolveDone(success) {
  document.getElementById('resolveStatusDot').className   =
    'resolve-status-dot ' + (success ? 'done' : 'error');
  document.getElementById('resolveStatusText').textContent =
    success ? 'Resolution complete — all systems nominal' : 'Resolution ended with errors';
  document.getElementById('resolveDoneBtn').style.display = 'inline-flex';
  document.getElementById('resolveCloseBtn').disabled     = false;

  // Refresh workflows so the card turns green
  if (success) setTimeout(fetchWorkflows, 3000);
}

// =============================================================================
// =============================================================================
// MODEL MONITORING TAB  — Watson OpenScale
// =============================================================================

// ---------------------------------------------------------------------------
// FETCH DEPLOYMENTS
// ---------------------------------------------------------------------------
async function fetchDeployments() {
  try {
    const res = await fetch(`${WF_API_BASE}/api/openscale/deployments`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allDeployments = await res.json();
    updateOsStats(allDeployments);
    renderDeployments(allDeployments);

    // badge: count deployments with alert status
    const alertCount = allDeployments.filter(d => d.overall_status === 'alert').length;
    const badge = document.getElementById('tabModelsBadge');
    badge.textContent = alertCount;
    badge.className   = 'tab-badge' + (alertCount > 0 ? ' tab-badge-red' : '');
  } catch (err) {
    console.warn('OpenScale fetch failed:', err.message);
    if (allDeployments.length === 0) {
      document.getElementById('osGrid').innerHTML = `
        <div class="wf-empty" style="grid-column:1/-1">
          <div class="empty-icon-wrap">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            </svg>
          </div>
          <div class="empty-title">Cannot reach backend — ensure FastAPI is running on port 8000 with IBM_API_KEY set</div>
        </div>`;
    }
  }
}

// ---------------------------------------------------------------------------
// OS STATS
// ---------------------------------------------------------------------------
function updateOsStats(deps) {
  const alerts   = deps.filter(d => d.overall_status === 'alert').length;
  const warnings = deps.filter(d => d.overall_status === 'warning').length;
  const healthy  = deps.filter(d => d.overall_status === 'ok').length;

  document.getElementById('osStatDeployments').textContent = deps.length;
  document.getElementById('osStatAlerts').textContent      = alerts;
  document.getElementById('osStatWarnings').textContent    = warnings;
  document.getElementById('osStatHealthy').textContent     = healthy;
}

// ---------------------------------------------------------------------------
// FILTER DEPLOYMENTS
// ---------------------------------------------------------------------------
function filterDeployments() {
  const q      = document.getElementById('osSearchInput').value.toLowerCase();
  const status = document.getElementById('osStatusFilter').value;

  const filtered = allDeployments.filter(d => {
    const matchQ = !q || (d.name || '').toLowerCase().includes(q);
    const matchS = !status || d.overall_status === status;
    return matchQ && matchS;
  });

  renderDeployments(filtered);
}

// ---------------------------------------------------------------------------
// RENDER DEPLOYMENT CARDS
// ---------------------------------------------------------------------------
function renderDeployments(deps) {
  const grid = document.getElementById('osGrid');
  if (!deps || deps.length === 0) {
    grid.innerHTML = `<div class="wf-empty" style="grid-column:1/-1">
      <div class="empty-icon-wrap">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </svg>
      </div>
      <div class="empty-title">No deployments found</div>
    </div>`;
    return;
  }
  grid.innerHTML = deps.map(buildOsCard).join('');
}

function osStatusClass(dep) {
  if (dep.overall_status === 'alert')   return 'os-card-alert';
  if (dep.overall_status === 'warning') return 'os-card-warning';
  if (dep.overall_status === 'ok')      return 'os-card-ok';
  return 'os-card-neutral';
}

function osStatusBadge(dep) {
  if (dep.overall_status === 'alert')
    return `<span class="badge badge-critical"><span class="status-dot firing"></span>Alert</span>`;
  if (dep.overall_status === 'warning')
    return `<span class="badge badge-warning">Warning</span>`;
  if (dep.overall_status === 'ok')
    return `<span class="badge badge-success"><span class="status-dot resolved"></span>Healthy</span>`;
  return `<span class="badge badge-neutral">Unknown</span>`;
}

function osMonitorRow(label, info) {
  if (!info) return '';
  const iconMap = {
    ok:      `<span class="os-mon-icon ok">✓</span>`,
    error:   `<span class="os-mon-icon error">✗</span>`,
    warning: `<span class="os-mon-icon warning">!</span>`,
    unknown: `<span class="os-mon-icon unknown">—</span>`,
  };
  const icon = iconMap[info.state] || iconMap.unknown;
  const alertCount = info.alert_count || 0;
  const stateLabel = info.state === 'ok'
    ? (alertCount > 0 ? `${alertCount} alert${alertCount > 1 ? 's' : ''}` : 'Healthy')
    : info.state === 'error'
      ? `${alertCount > 0 ? alertCount + ' alert' + (alertCount > 1 ? 's' : '') : 'Alert'}`
      : info.state === 'warning' ? 'Warning'
      : info.state === 'running' ? 'Running'
      : 'Unknown';
  return `
    <div class="os-monitor-row">
      ${icon}
      <span class="os-mon-label">${escHtml(label)}</span>
      <span class="os-mon-state">${escHtml(stateLabel)}</span>
    </div>`;
}

function buildOsCard(dep) {
  const monitors = dep.monitors || {};
  const monitorOrder = ['quality', 'fairness', 'drift_v2', 'explainability'];

  const monitorRows = monitorOrder
    .filter(k => monitors[k])
    .map(k => osMonitorRow(monitors[k].label, monitors[k]))
    .join('');

  const approvedBadge = dep.approved
    ? `<span class="badge badge-success" style="font-size:10px;padding:2px 8px">Approved</span>`
    : '';

  return `
<div class="os-card ${osStatusClass(dep)}" onclick="openOsDetail('${escHtml(dep.id)}')">
  <div class="os-card-header">
    ${osStatusBadge(dep)}
    <div style="display:flex;align-items:center;gap:6px">
      ${approvedBadge}
      <span class="os-binding-label">${escHtml(dep.deployment_type || 'online')}</span>
    </div>
  </div>

  <div class="os-card-name" title="${escHtml(dep.name)}">${escHtml(dep.name)}</div>

  <div class="os-monitors-list">
    ${monitorRows || '<div class="os-monitor-row"><span class="os-mon-state" style="color:var(--text-light)">No monitor data</span></div>'}
  </div>

  <div class="os-card-footer">
    <span class="wf-duration">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
      ${dep.last_evaluated ? 'Evaluated ' + formatRelative(dep.last_evaluated) : 'Not evaluated'}
    </span>
    ${dep.overall_status === 'alert' ? `
    <button class="btn-resolve" onclick="event.stopPropagation(); openOsDetail('${escHtml(dep.id)}')">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:5px">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      Investigate
    </button>` : ''}
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// DEPLOYMENT DETAIL MODAL
// ---------------------------------------------------------------------------
async function openOsDetail(subId) {
  const dep = allDeployments.find(d => d.id === subId);
  if (!dep) return;
  currentDeployment = dep;

  // Show modal immediately with a loading skeleton
  document.getElementById('osDetailTitle').textContent    = dep.name;
  document.getElementById('osDetailSubtitle').textContent =
    `${dep.deployment_type || 'online'} · ${dep.problem_type || 'binary'} · Watson OpenScale`;
  document.getElementById('osDetailContent').innerHTML =
    `<div class="os-detail-loading"><div class="os-loading-spinner"></div>Loading monitor details…</div>`;
  document.getElementById('osDetailOverlay').classList.add('open');

  try {
    const res = await fetch(`${WF_API_BASE}/api/openscale/deployments/${subId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = await res.json();
    currentDeployment = { ...dep, ...detail };
    renderOsDetail(currentDeployment);
  } catch (err) {
    document.getElementById('osDetailContent').innerHTML =
      `<div class="os-detail-loading" style="color:var(--critical)">Failed to load details: ${escHtml(err.message)}</div>`;
  }
}

function renderOsDetail(dep) {
  const monitors  = dep.monitors || {};
  const monOrder  = ['fairness', 'quality', 'drift_v2', 'explainability'];
  const hasAlerts = dep.overall_status === 'alert';

  // ── Summary row ──────────────────────────────────────────────────────────
  const tests = dep.tests;
  const totalAlerts = Object.values(monitors).reduce((s, m) => s + (m.alert_count || 0), 0);

  let donutHtml = '';
  if (tests && tests.run > 0) {
    const pct = Math.round((tests.passed / tests.run) * 100);
    donutHtml = `
      <div class="os-donut-wrap">
        <svg class="os-donut" viewBox="0 0 36 36">
          <circle class="os-donut-bg" cx="18" cy="18" r="15.915" fill="none" stroke-width="3.5"/>
          <circle class="os-donut-pass" cx="18" cy="18" r="15.915" fill="none" stroke-width="3.5"
            stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="25"/>
          <circle class="os-donut-fail" cx="18" cy="18" r="15.915" fill="none" stroke-width="3.5"
            stroke-dasharray="${100 - pct} ${pct}" stroke-dashoffset="${25 - pct}"/>
        </svg>
        <div class="os-donut-label">${tests.run}<div class="os-donut-sub">Tests run</div></div>
      </div>
      <div class="os-test-counts">
        <div class="os-test-stat passed">
          <span class="os-test-icon">✓</span><span class="os-test-num">${tests.passed}</span>
          <span class="os-test-lbl">Tests passed</span>
        </div>
        <div class="os-test-stat failed">
          <span class="os-test-icon">!</span><span class="os-test-num">${tests.failed}</span>
          <span class="os-test-lbl">Tests failed</span>
        </div>
      </div>`;
  }

  const scoringHtml = dep.scoring && (dep.scoring.last_eval || dep.scoring.last_7d) ? `
    <div class="os-stat-block">
      <div class="os-stat-label">Scoring requests</div>
      <div class="os-stat-row">
        ${dep.scoring.last_eval != null ? `<div class="os-stat-num">${dep.scoring.last_eval.toLocaleString()}<span class="os-stat-period"> in last evaluation</span></div>` : ''}
        ${dep.scoring.last_7d  != null ? `<div class="os-stat-num">${dep.scoring.last_7d.toLocaleString()}<span class="os-stat-period"> last 7 days</span></div>` : ''}
      </div>
    </div>` : '';

  const recordCounts = Object.values(monitors)
    .filter(m => m.records_count > 0)
    .map(m => m.records_count);
  const maxRecords = recordCounts.length ? Math.max(...recordCounts) : null;
  const recordsHtml = maxRecords ? `
    <div class="os-stat-block">
      <div class="os-stat-label">Records</div>
      <div class="os-stat-num">${maxRecords.toLocaleString()}<span class="os-stat-period"> in last evaluation</span></div>
    </div>` : '';

  const summaryHtml = `
    <div class="os-summary-row">
      <div class="os-summary-card">
        <div class="os-summary-card-title">Deployment details</div>
        ${dep.explanations != null ? `<div class="os-detail-kv"><span class="os-kv-label">Number of explanations</span><span class="os-kv-val accent">${dep.explanations}</span></div>` : ''}
        <div class="os-detail-kv"><span class="os-kv-label">Type</span><span class="os-kv-val">${escHtml(dep.deployment_type || 'online')}</span></div>
        <div class="os-detail-kv"><span class="os-kv-label">Problem</span><span class="os-kv-val">${escHtml(dep.problem_type || '—')}</span></div>
        ${dep.approved ? '<div class="os-detail-kv"><span class="os-kv-label">Status</span><span class="badge badge-success" style="font-size:10px">Approved</span></div>' : ''}
      </div>
      ${tests && tests.run > 0 ? `
      <div class="os-summary-card">
        <div class="os-summary-card-title">Test details</div>
        <div class="os-test-row">${donutHtml}</div>
      </div>` : ''}
      <div class="os-summary-card">
        <div class="os-summary-card-title">Model health
          <span class="os-health-arrow">→</span>
        </div>
        <div class="os-health-alert-count">
          <span class="os-health-icon ${totalAlerts > 0 ? 'error' : 'ok'}">${totalAlerts > 0 ? '!' : '✓'}</span>
          <span class="os-health-num">${totalAlerts}</span>
          <span class="os-health-label">Alert${totalAlerts !== 1 ? 's' : ''}</span>
        </div>
        ${scoringHtml}
        ${recordsHtml}
      </div>
    </div>`;

  // ── Monitor sections (metric tables) ─────────────────────────────────────
  const monSections = monOrder
    .filter(k => monitors[k])
    .map(k => {
      const m          = monitors[k];
      const alertCount = m.alert_count || 0;
      const metrics    = m.metrics || [];
      const isExplain  = k === 'explainability';

      const alertBadge = alertCount > 0
        ? `<span class="os-mon-alert-badge">Alerts triggered</span>`
        : `<span class="os-mon-ok-badge">No alerts</span>`;

      const alertNum = alertCount > 0
        ? `<div class="os-mon-alert-num"><span class="os-alert-dot">!</span>${alertCount}</div>` : '';

      // Fairness: show monitored group as sub-header
      const groupHeader = (k === 'fairness' && m.monitored_feature) ? `
        <div class="os-fairness-group">
          <span class="os-fg-label">Monitored feature</span>
          <span class="os-fg-val">${escHtml(m.monitored_feature)}${m.monitored_value ? ': ' + escHtml(m.monitored_value) : ''}</span>
        </div>` : '';

      let tableHtml = '<div class="os-no-metrics">No metric data available</div>';

      if (metrics.length > 0) {
        if (isExplain) {
          // Explainability: Feature | Influence score (no violation column)
          const rows = metrics.map(metric => {
            const valStr = metric.value == null ? '—' : metric.value;
            return `<tr>
              <td class="os-metric-name">${escHtml(metric.name)}</td>
              <td class="os-metric-val">${valStr}</td>
            </tr>`;
          }).join('');
          tableHtml = `
            <table class="os-metric-table">
              <thead><tr><th>Metric / Feature</th><th>Score</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`;
        } else {
          const rows = metrics.map(metric => {
            const valStr = metric.value == null ? '—'
              : metric.id === 'disparate_impact'
                ? (metric.value * 100).toFixed(2) + '%'
                : metric.value;
            const violNum  = metric.violation;
            const violStr  = violNum == null ? 'none'
              : violNum === 0   ? 'none'
              : violNum < 0.01  ? '<0.01'
              : String(violNum);
            const violClass = (violNum && violNum > 0) ? 'os-viol-yes' : 'os-viol-no';
            return `<tr>
              <td class="os-metric-name">${escHtml(metric.name)}</td>
              <td class="os-metric-val">${valStr}</td>
              <td class="os-metric-viol ${violClass}">${escHtml(violStr)}</td>
            </tr>`;
          }).join('');
          tableHtml = `
            <table class="os-metric-table">
              <thead><tr><th>Metric</th><th>Score</th><th>Violation</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`;
        }
      }

      const groupFooter = (!isExplain && (m.monitored_feature || m.monitored_value)) ? `
        <div class="os-mon-footer">Associated group: ${escHtml(m.monitored_feature || '')}${m.monitored_value ? ': ' + escHtml(m.monitored_value) : ''}</div>` : '';
      const recordsFooter = m.records_count > 0
        ? `<div class="os-mon-footer">${m.records_count.toLocaleString()} records evaluated</div>` : '';

      return `
        <div class="os-mon-section">
          <div class="os-mon-section-header">
            <span class="os-mon-section-title">${escHtml(m.label)}</span>
            ${alertBadge}
          </div>
          ${alertNum}
          ${groupHeader}
          ${tableHtml}
          ${groupFooter}
          ${recordsFooter}
        </div>`;
    }).join('');

  document.getElementById('osDetailContent').innerHTML =
    summaryHtml +
    `<div class="os-mon-grid">${monSections}</div>`;
}

function closeOsDetail(e) {
  if (e && e.target !== document.getElementById('osDetailOverlay')) return;
  document.getElementById('osDetailOverlay').classList.remove('open');
  currentDeployment = null;
}

function investigateModel() {
  if (!currentDeployment) return;
  // Open WINGS resolve modal with model context — reuses the same SSE log infrastructure
  // In production this calls WATSONX_ORCHESTRATE_WEBHOOK_URL with model context
  document.getElementById('osDetailOverlay').classList.remove('open');
  openResolveForModel(currentDeployment);
}

function openResolveForModel(dep) {
  if (resolveAbort) { resolveAbort.abort(); resolveAbort = null; }

  document.getElementById('resolveRunName').textContent =
    `Model: ${dep.name} · Watson OpenScale`;

  const meta = document.getElementById('resolveMetaStrip');
  meta.innerHTML = `
    <span class="resolve-meta-item">Type: <strong>${escHtml(dep.deployment_type || 'online')}</strong></span>
    <span class="resolve-meta-sep">·</span>
    <span class="resolve-meta-item">Problem: <strong>${escHtml(dep.problem_type || '—')}</strong></span>
    <span class="resolve-meta-sep">·</span>
    <span class="resolve-meta-item">Status: <strong style="color:#f85149">${escHtml(dep.overall_status)}</strong></span>
  `;
  meta.style.display = 'flex';

  document.getElementById('resolveLog').innerHTML = '';
  document.getElementById('resolveStatusText').textContent = 'Starting WINGS agent...';
  document.getElementById('resolveStatusDot').className   = 'resolve-status-dot running';
  document.getElementById('resolveDoneBtn').style.display = 'none';
  document.getElementById('resolveCloseBtn').disabled     = true;

  document.getElementById('resolveOverlay').classList.add('open');
  startModelInvestigateStream(dep);
}

async function startModelInvestigateStream(dep) {
  resolveAbort = new AbortController();

  // Build rich prompt from all monitor data
  const monitors = dep.monitors || {};
  const monitorLines = [];

  for (const [key, mon] of Object.entries(monitors)) {
    if (!mon) continue;
    monitorLines.push(`\n### ${mon.label || key} (${mon.alert_count || 0} alerts)`);
    if (mon.monitored_feature) {
      monitorLines.push(`Monitored feature: ${mon.monitored_feature}${mon.monitored_value ? ' = ' + mon.monitored_value : ''}`);
    }
    const metrics = mon.metrics || [];
    for (const m of metrics) {
      const violation = m.violation && m.violation > 0 ? ` | VIOLATION: ${m.violation}` : ' | no violation';
      monitorLines.push(`  - ${m.name}: ${m.value ?? '—'}${violation}`);
    }
  }

  const prompt =
    `You are analysing a production ML model with active monitoring alerts in IBM Watson OpenScale.\n\n` +
    `Model: ${dep.name || 'drug-test-classifier'}\n` +
    `Deployment type: ${dep.deployment_type || 'online'}\n` +
    `Problem type: ${dep.problem_type || 'binary'}\n` +
    `Overall status: ${dep.overall_status || 'error'}\n` +
    `Total alerts: ${dep.total_alerts || Object.values(monitors).reduce((s, m) => s + (m?.alert_count || 0), 0)}\n` +
    (dep.tests ? `Tests run: ${dep.tests.run} | Passed: ${dep.tests.passed} | Failed: ${dep.tests.failed}\n` : '') +
    `\n## Monitor Data\n` +
    monitorLines.join('\n') +
    `\n\nPlease provide:\n` +
    `1. Executive summary of the model health\n` +
    `2. Root cause analysis for each violated metric\n` +
    `3. Business risk and regulatory implications\n` +
    `4. Specific remediation steps (immediate, short-term, strategic)\n` +
    `5. Retraining recommendations with data requirements`;

  try {
    const res = await fetch(`${WF_API_BASE}/api/investigate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  resolveAbort.signal,
      body: JSON.stringify({
        message:   prompt,
        thread_id: null,
        agent_id:  MODEL_HEALTH_AGENT_ID,
      }),
    });

    if (!res.ok) {
      appendLogLine('error', `Backend error: HTTP ${res.status}`);
      setResolveDone(false);
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';
    let   fullText = '';

    appendLogLine('running', 'Agent is analysing...');
    const logEl = document.getElementById('resolveLog').lastElementChild;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const chunk = JSON.parse(raw);
          if (chunk.text) {
            fullText += chunk.text;
            if (logEl) logEl.querySelector('.log-msg').innerHTML = renderMarkdown(fullText);
            document.getElementById('resolveLog').scrollTop = document.getElementById('resolveLog').scrollHeight;
          }
          if (chunk.done) { setResolveDone(true); return; }
        } catch { /* ignore */ }
      }
    }

    setResolveDone(true);
  } catch (err) {
    if (err.name === 'AbortError') return;
    appendLogLine('error', `Stream error: ${err.message}`);
    setResolveDone(false);
  }
}


// =============================================================================
// SHARED UTILS
// =============================================================================
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatFull(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatRelative(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// =============================================================================
// EVIDENTLY AI TAB
// =============================================================================

async function fetchEvidently() {
  const loading = document.getElementById('evLoadingState');
  const errEl   = document.getElementById('evErrorState');
  const frame   = document.getElementById('evReportFrame');

  loading.style.display = '';
  errEl.style.display   = 'none';
  frame.style.display   = 'none';

  try {
    const res  = await fetch(`${WF_API_BASE}/api/evidently/latest`);
    const data = await res.json();

    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

    // Stats row
    const drift = data.drift || {};
    document.getElementById('evStatDrifted').textContent = drift.n_drifted != null
      ? `${drift.n_drifted} / ${drift.n_total}` : '—';
    document.getElementById('evStatTotal').textContent = drift.n_total || '—';
    document.getElementById('evStatUpdated').textContent = formatRelative(data.timestamp);
    document.getElementById('evModelVersion').textContent = `v${data.version || '—'}`;

    const driftCard = document.getElementById('evStatDriftCard');
    const driftEl   = document.getElementById('evStatDrift');
    if (drift.dataset_drift === true) {
      driftEl.textContent  = 'Drifted';
      driftCard.className  = 'stat-card stat-critical';
    } else {
      driftEl.textContent  = 'Stable';
      driftCard.className  = 'stat-card';
    }

    // Tab badge
    const nDrifted = drift.n_drifted || 0;
    const badge    = document.getElementById('tabEvidentlyBadge');
    badge.textContent = nDrifted;
    badge.className   = 'tab-badge' + (nDrifted > 0 ? ' tab-badge-red' : '');

    // Show iframe — reload to get latest HTML report
    loading.style.display = 'none';
    frame.src = `${WF_API_BASE}/api/evidently/report?t=${Date.now()}`;
    frame.style.display = '';

  } catch (err) {
    console.warn('Evidently fetch failed:', err.message);
    loading.style.display = 'none';
    errEl.style.display   = '';
    errEl.innerHTML = `
      <div class="ev-error-inner">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <div>
          <div style="font-weight:600;margin-bottom:4px">No drift report yet</div>
          <div style="color:var(--text-muted);font-size:12px">
            Run <code>python src/monitor_evidently.py</code> locally, or trigger the K8s CronJob.<br/>
            ${escHtml(err.message)}
          </div>
        </div>
      </div>`;
  }
}


// =============================================================================
// SETTINGS TAB
// =============================================================================

const SETTINGS_KEY = 'wings_alert_settings';

const SETTINGS_FIELDS = [
  'slackEnabled','slackWebhook','slackChannel','slackCritical','slackWarning','slackInfo',
  'emailEnabled','emailHost','emailPort','emailUser','emailPass','emailTo',
  'pdEnabled','pdKey','pdCritical','pdWarning',
  'webhookEnabled','webhookUrl','webhookAuth',
];

function saveSettings() {
  const data = {};
  SETTINGS_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    data[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
}

function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    SETTINGS_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || !(id in data)) return;
      if (el.type === 'checkbox') el.checked = data[id];
      else el.value = data[id];
    });
  } catch { /* ignore */ }
}

function _setTestResult(elId, ok, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? '#10b981' : '#ef4444';
  setTimeout(() => { el.textContent = ''; }, 4000);
}

function testSlack() {
  const url = document.getElementById('slackWebhook').value.trim();
  if (!url) return _setTestResult('slackTestResult', false, 'Enter a webhook URL first.');
  _setTestResult('slackTestResult', true, 'Sending test message...');
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: ':white_check_mark: *WINGS Platform* — Slack alert forwarding connected successfully.' }),
  })
    .then(r => _setTestResult('slackTestResult', r.ok, r.ok ? 'Connected successfully.' : `Error: HTTP ${r.status}`))
    .catch(e => _setTestResult('slackTestResult', false, `Failed: ${e.message}`));
}

function testEmail() {
  _setTestResult('emailTestResult', true, 'Email test requires backend support — settings saved.');
}

function testPagerDuty() {
  const key = document.getElementById('pdKey').value.trim();
  if (!key) return _setTestResult('pdTestResult', false, 'Enter an integration key first.');
  _setTestResult('pdTestResult', true, 'Sending test event...');
  fetch('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routing_key: key,
      event_action: 'trigger',
      payload: {
        summary: 'WINGS Platform — PagerDuty test alert',
        severity: 'info',
        source: 'wings-platform',
      },
    }),
  })
    .then(r => r.json().then(d => _setTestResult('pdTestResult', r.ok, r.ok ? `Connected. Dedup key: ${d.dedup_key}` : `Error: ${d.message}`)))
    .catch(e => _setTestResult('pdTestResult', false, `Failed: ${e.message}`));
}

function testWebhook() {
  const url = document.getElementById('webhookUrl').value.trim();
  const auth = document.getElementById('webhookAuth').value.trim();
  if (!url) return _setTestResult('webhookTestResult', false, 'Enter a URL first.');
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = auth;
  _setTestResult('webhookTestResult', true, 'Sending test payload...');
  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source: 'wings-platform', event: 'test', message: 'Webhook connection test from WINGS.' }),
  })
    .then(r => _setTestResult('webhookTestResult', r.ok, r.ok ? 'Connected successfully.' : `Error: HTTP ${r.status}`))
    .catch(e => _setTestResult('webhookTestResult', false, `Failed: ${e.message}`));
}
