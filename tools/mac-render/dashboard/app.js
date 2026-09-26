'use strict';

const byId = (id) => document.getElementById(id);
const state = {
  snapshot: null,
  connection: 'connecting',
  receivedAt: 0,
  failures: 0,
  controller: null,
  pollTimer: null,
  refreshAfterRequest: false,
  selectedId: null,
  selection: null,
  returnFocus: null,
  rendered: new Map(),
};
const statusNames = { queued: 'Queued', rendering: 'Rendering', completed: 'Completed', failed: 'Failed' };
const serviceNames = { recovering: 'Starting service', idle: 'Ready for jobs', busy: 'Rendering', stopping: 'Stopping service' };
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fullDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function title(job) { return job.title || 'Untitled render'; }
function resolution(job) { return job.resolution === '4k' ? '4K' : job.resolution || 'Not recorded'; }
function format(job) { return job.format ? job.format.toUpperCase() : 'Not recorded'; }
function quality(job) { return job.quality ? `${job.quality[0].toUpperCase()}${job.quality.slice(1)}` : 'Not recorded'; }
function duration(seconds) {
  if (!Number.isFinite(seconds)) return 'Not recorded';
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}
function date(seconds, full = false) {
  return Number.isFinite(seconds) ? (full ? fullDateFormat : dateFormat).format(new Date(seconds * 1000)) : 'Not recorded';
}
function badge(job) {
  const node = element('span', 'status-pill');
  node.dataset.status = job.status;
  node.append(element('span', 'status-dot'), element('span', '', statusNames[job.status] || job.status));
  return node;
}
function jobButton(job, className = 'text-button', label = title(job)) {
  const button = element('button', className, label);
  button.type = 'button';
  button.setAttribute('aria-label', `View details for ${title(job)}`);
  button.addEventListener('click', () => openDetails(job, button));
  return button;
}
function renderChanged(key, value, render) {
  const serialized = JSON.stringify(value);
  if (state.rendered.get(key) === serialized) return;
  state.rendered.set(key, serialized);
  render();
}

function validSnapshot(value) {
  const isJob = (job) => job && typeof job.render_id === 'string' && Object.hasOwn(statusNames, job.status);
  return value && Number.isFinite(value.observed_at) && value.service && Object.hasOwn(serviceNames, value.service.state)
    && (value.active === null || isJob(value.active)) && Array.isArray(value.queued) && value.queued.every(isJob)
    && Array.isArray(value.recent) && value.recent.every(isJob) && Number.isFinite(value.recent_total);
}

function setStatus(id, connection, text) {
  const node = byId(id);
  node.dataset.state = connection;
  node.lastElementChild.textContent = text;
}

function renderConnection() {
  const connected = state.connection === 'live';
  const connectionText = { connecting: 'Connecting', live: 'Live', stale: 'Connection lost', offline: 'Offline' }[state.connection];
  setStatus('connection-status', state.connection, connectionText);
  const service = state.snapshot?.service;
  setStatus('machine-state', connected ? service.state : state.connection, connected ? serviceNames[service.state] : connectionText);
  const notice = byId('connection-notice');
  notice.hidden = connected || state.connection === 'connecting';
  if (!notice.hidden) {
    notice.textContent = state.snapshot
      ? `Connection lost. Showing the last update from ${date(state.snapshot.observed_at, true)}. Retrying automatically.`
      : 'Cannot reach the render service. Check that the service is running on this Mac. Retrying automatically.';
  }
  byId('details-connection').dataset.state = state.connection;
  byId('details-connection-status').textContent = connected ? 'Live connection' : `${connectionText}. Details may be out of date.`;
  byId('details-snapshot-time').textContent = state.snapshot
    ? `Snapshot ${date(state.snapshot.observed_at, true)}` : 'Waiting for the first update';
  updateTimes();
}

function renderMachine() {
  const service = state.snapshot.service;
  byId('machine-name').textContent = service.host || 'This Mac';
  byId('machine-chip').textContent = service.chip || 'Chip not reported';
  byId('renderer-version').textContent = service.hyperframes_version || 'Starting renderer';
  const latest = service.hyperframes_latest_seen;
  byId('renderer-version').title = latest ? `Latest observed release ${latest}` : 'The service has not checked the latest release yet.';
  byId('gpu-config').textContent = service.gpu_encode === true ? 'GPU encoding enabled'
    : service.gpu_encode === false ? 'GPU encoding disabled' : `${service.gpu_encode || 'Auto'}`;
  byId('queue-capacity').textContent = `${service.queue_capacity} waiting jobs`;
}

function renderCurrent() {
  const current = byId('current-job');
  const job = state.snapshot?.active;
  const service = state.snapshot?.service;
  current.replaceChildren();
  byId('active-count').textContent = job ? '1 active' : state.snapshot ? 'No active render' : 'Unavailable';
  if (!job) {
    const empty = element('div', 'idle-state');
    let heading = 'Ready for the next render';
    let message = 'Jobs submitted to this Mac will appear here as they start.';
    if (!state.snapshot) {
      heading = 'Service unavailable';
      message = 'Current job status will appear when the connection returns.';
    } else if (service.state === 'recovering') {
      heading = 'Starting the render service';
      message = 'The service is checking its renderer and recovering saved jobs.';
    } else if (service.state === 'stopping') {
      heading = 'The service is stopping';
      message = 'The last reported queue is shown alongside this panel.';
    } else if (state.snapshot.queued.length) {
      heading = 'Waiting for the next job to start';
      message = 'The queue retains submission order. The next update will show the active job.';
    }
    empty.append(element('span', 'job-phase', state.snapshot ? serviceNames[service.state] : 'Not connected'), element('h3', '', heading), element('p', '', message));
    current.append(empty);
    return;
  }
  const phase = element('div', 'job-phase');
  phase.append(element('span', 'status-dot'), element('span', '', job.phase === 'preparing' ? 'Preparing render' : 'Rendering'));
  const specs = element('div', 'job-specs');
  for (const spec of [resolution(job), format(job), `${job.fps} fps`, `${quality(job)} quality`]) specs.append(element('span', '', spec));
  const elapsed = element('div');
  const elapsedValue = element('span', 'elapsed-value');
  elapsedValue.id = 'job-elapsed';
  elapsed.append(element('span', 'elapsed-label', 'Job elapsed'), elapsedValue);
  const bottom = element('div', 'current-bottom');
  bottom.append(elapsed, jobButton(job, 'text-button', 'View details'));
  current.append(phase, element('h3', '', title(job)), element('p', 'job-id', job.render_id), specs, bottom);
}

function renderQueue() {
  const queued = state.snapshot?.queued || [];
  byId('queue-count').textContent = state.snapshot ? String(queued.length) : 'Unknown';
  const list = byId('queue-list');
  list.replaceChildren();
  for (const [index, job] of queued.entries()) {
    const row = element('li');
    const content = element('div', 'queue-job');
    content.append(jobButton(job, 'text-button queue-title'), element('p', 'queue-meta', `${resolution(job)} · ${format(job)} · ${quality(job)} quality`));
    row.append(element('span', 'queue-position', String(index + 1).padStart(2, '0')), content);
    list.append(row);
  }
  const empty = byId('queue-empty');
  empty.hidden = queued.length > 0;
  empty.replaceChildren();
  if (!queued.length) {
    empty.append(element('strong', '', state.snapshot ? 'No jobs waiting' : 'Queue unavailable'), element('p', '', state.snapshot
      ? 'The next submitted job will run as soon as the renderer is available.'
      : 'Queue order will appear when the connection returns.'));
  }
}

function renderHistory() {
  const recent = state.snapshot?.recent || [];
  const query = byId('job-search').value.trim().toLocaleLowerCase();
  const status = byId('status-filter').value;
  const filtered = recent.filter((job) => (status === 'all' || job.status === status)
    && `${title(job)} ${job.render_id}`.toLocaleLowerCase().includes(query));
  const summary = byId('history-summary');
  if (!state.snapshot) summary.textContent = 'History is unavailable until the service connects.';
  else if (query || status !== 'all') summary.textContent = `${filtered.length} matching ${filtered.length === 1 ? 'job' : 'jobs'} in the ${recent.length} most recent.`;
  else summary.textContent = recent.length < state.snapshot.recent_total
    ? `Showing the latest ${recent.length} of ${state.snapshot.recent_total} retained jobs.`
    : `${recent.length} finished ${recent.length === 1 ? 'job' : 'jobs'} retained by this service.`;
  renderChanged('history', [filtered, state.connection === 'connecting'], () => {
    const rows = byId('history-rows');
    rows.replaceChildren();
    for (const job of filtered) {
      const row = element('tr');
      const jobCell = element('td');
      jobCell.append(jobButton(job, 'text-button table-job-title'), element('span', 'job-id', job.render_id));
      const statusCell = element('td');
      statusCell.append(badge(job));
      const outputCell = element('td', 'table-output', `${resolution(job)} · ${format(job)}`);
      outputCell.append(element('span', '', `${job.fps} fps · ${quality(job)}`));
      const completedCell = element('td', 'table-time', date(job.completed_at));
      completedCell.title = date(job.completed_at, true);
      row.append(jobCell, statusCell, outputCell, element('td', 'table-duration', duration(job.render_seconds)), completedCell);
      rows.append(row);
    }
  });
  const empty = byId('history-empty');
  empty.hidden = filtered.length > 0;
  empty.replaceChildren();
  if (!filtered.length) {
    let heading = 'No finished jobs yet';
    let message = 'Completed and failed renders will appear here.';
    if (!state.snapshot) {
      heading = 'Job history unavailable';
      message = 'Waiting for the render service to reconnect.';
    } else if (query || status !== 'all') {
      heading = 'No matching jobs';
      message = 'Try a different name, job ID, or status.';
    }
    empty.append(element('strong', '', heading), element('p', '', message));
  }
}

function openDetails(job, button) {
  state.selectedId = job.render_id;
  state.selection = job;
  state.returnFocus = button;
  renderDetails();
  byId('job-details').showModal();
  byId('details-heading').focus();
}

function closeDetails() {
  byId('job-details').close();
}

function restoreDetailsFocus() {
  state.selectedId = null;
  state.selection = null;
  state.rendered.delete('details');
  if (state.returnFocus?.isConnected) state.returnFocus.focus();
  else byId('job-search').focus();
}

function renderDetails() {
  if (!state.selectedId) return;
  const jobs = state.snapshot ? [state.snapshot.active, ...state.snapshot.queued, ...state.snapshot.recent] : [];
  const current = jobs.find((job) => job?.render_id === state.selectedId);
  if (current) state.selection = current;
  const job = state.selection;
  renderChanged('details', [job, Boolean(current)], () => {
    const content = byId('details-content');
    content.replaceChildren();
    const heading = element('h3', '', title(job));
    heading.id = 'details-title';
    content.append(badge(job), heading, element('p', 'job-id', job.render_id));
    const resultState = job.status !== 'completed' ? 'Not produced'
      : Number.isFinite(job.purged_at) ? 'Deleted'
        : Number.isFinite(job.purge_after) ? 'Cleanup pending' : 'Available';
    const resultDates = [
      ['Last sent', job.sent_at],
      ['Cleanup scheduled', job.purge_after],
      ['Deleted at', job.purged_at],
    ].filter(([, timestamp]) => Number.isFinite(timestamp));
    const fields = element('dl', 'details-fields');
    for (const [label, value] of [
      ['Result file', resultState],
      ...resultDates.map(([label, timestamp]) => [label, date(timestamp, true)]),
      ['Output', `${resolution(job)} · ${format(job)}`],
      ['Frame rate', `${job.fps} fps`],
      ['Quality', quality(job)],
      ['Aspect ratio', job.aspect_ratio || 'Project default'],
      ['Submitted', date(job.created_at, true)],
      ['Started', job.started_at ? date(job.started_at, true) : 'Not started'],
      ['Finished', job.completed_at ? date(job.completed_at, true) : 'Not finished'],
      ['Render time', duration(job.render_seconds)],
      ['Attempts', String(job.attempts)],
      ['HyperFrames', job.hyperframes_version || 'Not assigned'],
    ]) {
      const entry = element('div');
      entry.append(element('dt', '', label), element('dd', '', value));
      fields.append(entry);
    }
    content.append(fields);
    if (job.failure_message) content.append(element('p', 'failure-message', job.failure_message));
    if (job.status === 'completed') content.append(element('p', 'details-note', 'Completed records the render outcome. The job stays completed after its result file is deleted.'));
    if (!current) content.append(element('p', 'details-note', 'This job is no longer in the latest snapshot. These are its last observed details.'));
    else if (job.status === 'rendering') content.append(element('p', 'details-note', 'The service reports preparation and rendering phases. Frame progress and a finish estimate are not available.'));
  });
}

function updateTimes() {
  if (!state.snapshot) return;
  const secondsSinceReceipt = (performance.now() - state.receivedAt) / 1000;
  const observed = state.snapshot.observed_at + (state.connection === 'live' ? secondsSinceReceipt : 0);
  const elapsed = byId('job-elapsed');
  if (elapsed) elapsed.textContent = duration(state.snapshot.active?.started_at ? observed - state.snapshot.active.started_at : 0);
  byId('updated-at').textContent = state.connection !== 'live' ? `Last update ${date(state.snapshot.observed_at)}`
    : secondsSinceReceipt < 5 ? 'Updated just now' : `Updated ${duration(secondsSinceReceipt)} ago`;
}

function renderSnapshot() {
  renderConnection();
  if (state.snapshot) renderMachine();
  renderChanged('current', [state.snapshot?.active, state.snapshot?.service.state, Boolean(state.snapshot?.queued.length), Boolean(state.snapshot)], renderCurrent);
  renderChanged('queue', [state.snapshot?.queued, Boolean(state.snapshot)], renderQueue);
  renderHistory();
  renderDetails();
  updateTimes();
  const summary = state.snapshot ? `${state.snapshot.active ? 'One active job' : 'No active job'}, ${state.snapshot.queued.length} queued.` : 'Render service unavailable.';
  if (byId('announcement').textContent !== summary) byId('announcement').textContent = summary;
}

async function poll() {
  clearTimeout(state.pollTimer);
  if (document.hidden || state.controller) return;
  const controller = new AbortController();
  state.controller = controller;
  byId('refresh').disabled = true;
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Status request failed');
    const snapshot = await response.json();
    if (!validSnapshot(snapshot)) throw new Error('Status response is invalid');
    if (document.hidden) return;
    state.snapshot = snapshot;
    state.receivedAt = performance.now();
    state.connection = 'live';
    state.failures = 0;
    renderSnapshot();
  } catch {
    if (!document.hidden) {
      state.connection = state.snapshot ? 'stale' : 'offline';
      state.failures += 1;
      renderSnapshot();
    }
  } finally {
    clearTimeout(timeout);
    state.controller = null;
    byId('refresh').disabled = false;
    if (!document.hidden) {
      const delay = state.refreshAfterRequest ? 0 : state.failures ? Math.min(15000, 2000 * 2 ** Math.min(state.failures, 3)) : 2000;
      state.refreshAfterRequest = false;
      state.pollTimer = setTimeout(poll, delay);
    }
  }
}

byId('refresh').addEventListener('click', poll);
byId('job-search').addEventListener('input', renderHistory);
byId('status-filter').addEventListener('change', renderHistory);
byId('close-details').addEventListener('click', closeDetails);
byId('job-details').addEventListener('close', restoreDetailsFocus);
document.addEventListener('visibilitychange', () => {
  clearTimeout(state.pollTimer);
  if (document.hidden) state.controller?.abort();
  else if (state.controller) state.refreshAfterRequest = true;
  else poll();
});
setInterval(() => { if (!document.hidden) updateTimes(); }, 1000);
poll();
