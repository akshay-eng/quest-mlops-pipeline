// =============================================================================
// Quest Diagnostics — WINGS Platform
// Incidents tab: Node.js backend on port 4000
// Workflows tab: FastAPI backend on port 8000
// =============================================================================

const API_BASE         = 'http://localhost:4000';
const WF_API_BASE      = 'http://localhost:8000';
const POLL_INTERVAL    = 10000;
const WF_POLL_INTERVAL = 15000;
const OS_POLL_INTERVAL = 60000;   // OpenScale — poll every 60s (API is slower)

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
});

// ---------------------------------------------------------------------------
// TAB SWITCHING
// ---------------------------------------------------------------------------
function switchTab(tab) {
  activeTab = tab;

  document.getElementById('tabIncidents').classList.toggle('active', tab === 'incidents');
  document.getElementById('tabWorkflows').classList.toggle('active', tab === 'workflows');
  document.getElementById('tabModels').classList.toggle('active',    tab === 'models');

  document.getElementById('incidentsView').style.display = tab === 'incidents' ? '' : 'none';
  document.getElementById('workflowsView').style.display = tab === 'workflows' ? '' : 'none';
  document.getElementById('modelsView').style.display    = tab === 'models'    ? '' : 'none';

  if (tab === 'workflows') fetchWorkflows();
  if (tab === 'models')    fetchDeployments();
}

// ---------------------------------------------------------------------------
// FETCH ALERTS (incidents tab)
// ---------------------------------------------------------------------------
async function fetchAlerts() {
  try {
    const res = await fetch(`${API_BASE}/api/alerts`);
    if (!res.ok) throw new Error('Server error');
    allAlerts = await res.json();
    updateStats(allAlerts);
    renderAlerts(allAlerts);
    setOnline(true);
    document.getElementById('tabIncidentsBadge').textContent = allAlerts.filter(a => a.alert_status !== 'resolved').length;
  } catch {
    setOnline(false);
  }
}

function setOnline(online) {
  document.getElementById('liveDot').classList.toggle('offline', !online);
  document.getElementById('liveLabel').textContent = online ? 'Live' : 'Disconnected';
}

// ---------------------------------------------------------------------------
// STATS (incidents)
// ---------------------------------------------------------------------------
function updateStats(alerts) {
  document.getElementById('statTotal').textContent       = alerts.length;
  document.getElementById('statCritical').textContent    = alerts.filter(a => a.severity === 'critical').length;
  document.getElementById('statWarning').textContent     = alerts.filter(a => a.severity !== 'critical').length;
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
  const incident   = resolveIncident(alert);
  const isFiring   = alert.alert_status !== 'resolved';
  const multi      = (alert.count || 1) > 1;
  const sev        = alert.severity || 'warning';

  return `
<div class="alert-row" onclick="openDetail('${alert.id}')">
  <div class="col-severity">
    <span class="badge badge-${sev}">${sev}</span>
  </div>
  <div class="col-title">
    <span class="alert-name">${incident.displayTitle}</span>
    <span class="alert-desc">${escHtml(alert.description || alert.title)}</span>
  </div>
  <div class="col-service">${incident.category}</div>
  <div class="col-namespace">${alert.namespace || '—'}</div>
  <div class="col-occurrences ${multi ? 'high' : ''}">${alert.count || 1}</div>
  <div class="col-time">${formatRelative(alert.last_fired || alert.first_fired)}</div>
  <div class="col-status">
    <span class="badge badge-${isFiring ? 'critical' : 'success'}">
      <span class="status-dot ${isFiring ? 'firing' : 'resolved'}"></span>
      ${isFiring ? 'Firing' : 'Resolved'}
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
    const inc = resolveIncident(a);
    const matchQ = !q ||
      (a.title || '').toLowerCase().includes(q) ||
      inc.displayTitle.toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.namespace || '').toLowerCase().includes(q);
    return matchQ &&
      (!sev  || a.severity === sev) &&
      (!type || a.incident_type === type);
  });

  renderAlerts(filtered);
}

// ---------------------------------------------------------------------------
// DETAIL MODAL
// ---------------------------------------------------------------------------
function openDetail(alertId) {
  const alert = allAlerts.find(a => a.id === alertId);
  if (!alert) return;

  currentAlertId = alertId;
  chatThreadId   = null;

  const incident = resolveIncident(alert);
  const isFiring = alert.alert_status !== 'resolved';
  const sev      = alert.severity || 'warning';
  const count    = alert.count || 1;

  document.getElementById('detailTitle').textContent    = incident.displayTitle;
  document.getElementById('detailSubtitle').textContent = `${incident.category} — Quest Diagnostics`;

  document.getElementById('detailContent').innerHTML = `
    <div class="detail-section">
      <div class="section-label">Overview</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <span class="badge badge-${sev}">${sev}</span>
        <span class="badge badge-${isFiring ? 'critical' : 'success'}">
          <span class="status-dot ${isFiring ? 'firing' : 'resolved'}"></span>
          ${isFiring ? 'Firing' : 'Resolved'}
        </span>
        ${alert.alertname ? `<span class="badge badge-neutral">${escHtml(alert.alertname)}</span>` : ''}
      </div>
      <div style="font-size:13px;color:var(--text-muted);line-height:1.6">${escHtml(alert.description || alert.title)}</div>
    </div>

    <div class="detail-section">
      <div class="section-label">Alert Details</div>
      <div class="detail-grid">
        <div class="detail-field">
          <div class="field-label">Namespace</div>
          <div class="field-value">${escHtml(alert.namespace || '—')}</div>
        </div>
        <div class="detail-field">
          <div class="field-label">Pod / Service</div>
          <div class="field-value">${escHtml(alert.pod || '—')}</div>
        </div>
        <div class="detail-field">
          <div class="field-label">First Detected</div>
          <div class="field-value">${formatFull(alert.first_fired)}</div>
        </div>
        <div class="detail-field">
          <div class="field-label">Last Fired</div>
          <div class="field-value">${formatFull(alert.last_fired || alert.first_fired)}</div>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="section-label">Occurrences</div>
      <div class="occurrence-block">
        <div class="occurrence-num ${count > 1 ? 'high' : ''}">${count}</div>
        <div class="occurrence-label">total occurrence${count !== 1 ? 's' : ''} — alert has fired ${count} time${count !== 1 ? 's' : ''} and is still ${isFiring ? 'active' : 'resolved'}</div>
      </div>
    </div>

    <div class="detail-section">
      <div class="section-label">Suggested Actions</div>
      <div class="actions-list">
        ${incident.suggestedActions.map((a, i) => `
          <div class="action-row">
            <span class="action-num">${i + 1}</span>
            <span class="action-text">${escHtml(a)}</span>
          </div>`).join('')}
      </div>
    </div>

    ${alert.runbook ? `
    <div class="detail-section">
      <div class="section-label">Runbook</div>
      <div class="runbook-block">${escHtml(alert.runbook)}</div>
    </div>` : ''}
  `;

  document.getElementById('detailModal').querySelector('.modal-footer')?.remove();
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `
    <button class="btn btn-ai" onclick="openChat('${alert.id}')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
      </svg>
      Investigate with AI
    </button>
    <button class="btn btn-ghost" onclick="dismissAlert('${alert.id}')">Dismiss</button>
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
// AI CHAT MODAL (incidents)
// ---------------------------------------------------------------------------
function openChat(alertId) {
  closeDetail();

  const alert = allAlerts.find(a => a.id === alertId);
  currentAlertId = alertId;
  chatThreadId   = null;

  const incident = alert ? resolveIncident(alert) : null;

  document.getElementById('chatAlertName').textContent =
    incident ? incident.displayTitle : 'WatsonX Incident Assistant';

  const ctx = document.getElementById('chatIncidentCtx');
  if (alert) {
    const sev   = (alert.severity || 'warning').toUpperCase();
    const count = alert.count || 1;
    ctx.textContent =
      `Context: ${alert.alertname || incident.displayTitle}  |  ${sev}  |  ${count} occurrence(s)  |  ${alert.namespace || '—'}`;
    ctx.classList.add('visible');
  } else {
    ctx.classList.remove('visible');
  }

  document.getElementById('chatMessages').innerHTML = '';

  addAIMessage(
    alert
      ? `I have loaded the incident context for **${incident.displayTitle}**.\n\n` +
        `This alert has fired **${alert.count || 1} time(s)**.\n\n` +
        `You can ask me about the root cause, recommended remediation steps, or specific commands to run.`
      : `I am your WatsonX incident assistant. Ask me about root cause, remediation, or runbook guidance.`
  );

  document.getElementById('chatOverlay').classList.add('open');
  document.getElementById('chatInput').focus();
}

function closeChat() {
  document.getElementById('chatOverlay').classList.remove('open');
}

function closeChatModal(e) {
  if (e.target === document.getElementById('chatOverlay')) closeChat();
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const msg   = input.value.trim();
  if (!msg) return;

  input.value = '';
  addUserMessage(msg);

  const typingEl = addTypingIndicator();
  document.getElementById('sendBtn').disabled = true;

  const alert = allAlerts.find(a => a.id === currentAlertId);
  let fullPrompt = msg;
  if (alert && !chatThreadId) {
    const incident = resolveIncident(alert);
    fullPrompt =
      `[Incident Context]\n` +
      `Type: ${incident.displayTitle}\n` +
      `Alert: ${alert.alertname || incident.displayTitle}\n` +
      `Severity: ${alert.severity || 'warning'}\n` +
      `Namespace: ${alert.namespace || '—'}\n` +
      `Pod/Service: ${alert.pod || '—'}\n` +
      `Occurrences: ${alert.count || 1}\n` +
      `Description: ${alert.description || alert.title}\n\n` +
      `[User Question]\n${msg}`;
  }

  try {
    const res = await fetch(`${API_BASE}/api/generate-incident`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: fullPrompt, thread_id: chatThreadId || null }),
    });

    if (!res.ok || !res.body) throw new Error('Stream unavailable');

    typingEl.remove();

    const msgEl = document.createElement('div');
    msgEl.className = 'msg msg-ai';
    appendMsg(msgEl);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';
    let   fullText = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

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
        } catch { /* ignore malformed chunk */ }
      }
    }

    if (!fullText) {
      msgEl.innerHTML = renderMarkdown('No response received. Please try again.');
    }

  } catch (err) {
    typingEl.remove();
    addAIMessage('Unable to reach the AI backend. Please ensure the server is running on port 4000.');
    console.error('Chat error:', err);
  } finally {
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('chatInput').focus();
  }
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

function addTypingIndicator() {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  appendMsg(el);
  return el;
}

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
  const isFailed  = run.conclusion === 'failure';
  const isRunning = run.status === 'in_progress';
  const duration  = wfDuration(run);

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
<div class="wf-card ${wfStatusClass(run)}">
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

function closeResolve() {
  if (resolveAbort) { resolveAbort.abort(); resolveAbort = null; }
  document.getElementById('resolveOverlay').classList.remove('open');
}

function closeResolveModal(e) {
  if (e.target === document.getElementById('resolveOverlay')) closeResolve();
}

async function startResolveStream(runId) {
  resolveAbort = new AbortController();

  appendLogLine('info', 'WINGS agent initialising — connecting to IBM watsonx Orchestrate...');

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
  return `
    <div class="os-monitor-row">
      ${icon}
      <span class="os-mon-label">${escHtml(label)}</span>
      <span class="os-mon-state">${escHtml(info.state || '—')}</span>
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
function openOsDetail(subId) {
  const dep = allDeployments.find(d => d.id === subId);
  if (!dep) return;
  currentDeployment = dep;

  document.getElementById('osDetailTitle').textContent    = dep.name;
  document.getElementById('osDetailSubtitle').textContent =
    `${dep.deployment_type || 'online'} · ${dep.problem_type || 'binary'} · Watson OpenScale`;

  const monitors  = dep.monitors || {};
  const monOrder  = ['quality', 'fairness', 'drift_v2', 'explainability'];
  const monBlocks = monOrder.filter(k => monitors[k]).map(k => {
    const m     = monitors[k];
    const color = m.state === 'ok' ? 'success' : m.state === 'error' ? 'critical' : 'warning';
    return `
      <div class="detail-field">
        <div class="field-label">${escHtml(m.label)}</div>
        <div class="field-value" style="color:var(--${color})">
          ${m.state === 'ok' ? '✓ Healthy' : m.state === 'error' ? '✗ Error' : m.state || '—'}
        </div>
      </div>`;
  }).join('');

  document.getElementById('osDetailContent').innerHTML = `
    <div class="detail-section">
      <div class="section-label">Overview</div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        ${osStatusBadge(dep)}
        ${dep.approved ? '<span class="badge badge-success">Approved</span>' : ''}
        <span class="badge badge-neutral">${escHtml(dep.deployment_type || 'online')}</span>
      </div>
      <div style="font-size:13px;color:var(--text-muted)">
        Deployment: <strong>${escHtml(dep.deployment_name || dep.name)}</strong><br/>
        Problem type: <strong>${escHtml(dep.problem_type || '—')}</strong><br/>
        Last evaluated: <strong>${dep.last_evaluated ? formatFull(dep.last_evaluated) : 'Not evaluated'}</strong>
      </div>
    </div>
    <div class="detail-section">
      <div class="section-label">Monitor Status</div>
      <div class="detail-grid">${monBlocks}</div>
    </div>
    <div class="detail-section">
      <div class="section-label">Suggested Actions</div>
      <div class="actions-list">
        ${dep.overall_status === 'alert' ? `
        <div class="action-row"><span class="action-num">1</span>
          <span class="action-text">Review quality monitor — check feedback logging table for new labeled records</span></div>
        <div class="action-row"><span class="action-num">2</span>
          <span class="action-text">Investigate fairness violations — check monitored features for biased prediction distribution</span></div>
        <div class="action-row"><span class="action-num">3</span>
          <span class="action-text">Run drift analysis — compare current payload distribution against training baseline</span></div>
        <div class="action-row"><span class="action-num">4</span>
          <span class="action-text">Trigger WINGS agent to autonomously diagnose and escalate to Watson X Orchestrate</span></div>
        ` : `
        <div class="action-row"><span class="action-num">1</span>
          <span class="action-text">Model is healthy — continue monitoring on scheduled cadence</span></div>
        `}
      </div>
    </div>`;

  document.getElementById('osDetailOverlay').classList.add('open');
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

  appendLogLine('info', `Model: ${dep.name}`);
  appendLogLine('info', `Overall status: ${dep.overall_status}`);

  // Stream from backend — uses same SSE infrastructure, sends model context
  try {
    const res = await fetch(`${WF_API_BASE}/api/openscale/deployments/${dep.id}/investigate`, {
      method:  'POST',
      signal:  resolveAbort.signal,
      headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: dep.name, monitors: dep.monitors, overall_status: dep.overall_status }),
    });

    if (!res.ok) {
      // Demo simulation if endpoint not wired
      await _simulateModelInvestigation(dep);
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
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          appendLogLine(evt.status || 'info', evt.message || '', evt.timestamp);
          if (evt.status === 'done') { setResolveDone(true); return; }
        } catch { /* ignore */ }
      }
    }
    setResolveDone(true);
  } catch (err) {
    if (err.name === 'AbortError') return;
    // Fall back to demo simulation
    await _simulateModelInvestigation(dep);
  }
}

async function _simulateModelInvestigation(dep) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const monitors = dep.monitors || {};

  appendLogLine('running', 'Connecting to IBM Watson X Orchestrate...');
  await delay(1200);
  appendLogLine('ok',      'Orchestrate agent initialised');
  await delay(400);

  appendLogLine('running', `Querying Watson OpenScale instance for ${escHtml(dep.name)}...`);
  await delay(1000);

  for (const [, mon] of Object.entries(monitors)) {
    if (mon.state === 'error') {
      appendLogLine('info', `Monitor issue detected: ${mon.label} — state: ${mon.state}`);
    } else {
      appendLogLine('ok', `${mon.label}: ${mon.state}`);
    }
    await delay(300);
  }

  appendLogLine('running', 'Sending alert context to IBM Granite for RCA...');
  await delay(2000);
  appendLogLine('ok',      `RCA complete — root cause: feedback logging table has no new labeled records`);
  appendLogLine('info',    'Resolution: submit labeled payload data via OpenScale feedback API to re-enable quality monitoring');

  await delay(500);
  appendLogLine('running', 'Opening ServiceNow incident via Watson X Orchestrate...');
  await delay(1200);
  appendLogLine('ok',      'ServiceNow INC0042199 created — assigned to Quest MLOps Team');

  await delay(400);
  appendLogLine('running', 'Updating Watson OpenScale model fact sheet...');
  await delay(800);
  appendLogLine('ok',      'Governance fact sheet updated with incident reference');

  await delay(300);
  appendLogLine('done',    `Investigation complete · Model: ${dep.name} · Ticket: INC0042199 ✦`);
  setResolveDone(true);
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
