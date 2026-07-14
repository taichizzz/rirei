/* global document, localStorage, window, Terminal, FitAddon, setTimeout */
let project = localStorage.getItem('relay-project') || '';
const output = document.querySelector('#output');
const projectName = document.querySelector('#projectName');
const signal = document.querySelector('#signal');
const card = document.querySelector('.terminal-card');
const terminalEl = document.querySelector('#terminal');
let terminalRunning = false;
let commandRunning = false;
const projectButton = document.querySelector('#choose');
const commandButtons = [...document.querySelectorAll('[data-command]')];
const interactiveButtons = [...document.querySelectorAll('[data-interactive]')];
const profileButtons = [...document.querySelectorAll('[data-profile-agent]')];
const stopButton = document.querySelector('#stop');
const showTerminalButton = document.querySelector('#showTerminal');
const dashboard = document.querySelector('#dashboard');
const dashboardRefreshButton = document.querySelector('#dashboardRefresh');
const dashboardTitle = document.querySelector('#dashboardTitle');
const dashboardStatus = document.querySelector('#dashboardStatus');
const dashboardAgent = document.querySelector('#dashboardAgent');
const dashboardBranch = document.querySelector('#dashboardBranch');
const dashboardChanges = document.querySelector('#dashboardChanges');
const dashboardCheckpoint = document.querySelector('#dashboardCheckpoint');
const dashboardTest = document.querySelector('#dashboardTest');
const dashboardRemaining = document.querySelector('#dashboardRemaining');
const dashboardDecisions = document.querySelector('#dashboardDecisions');
const dashboardBlockers = document.querySelector('#dashboardBlockers');
const timelineOpen = document.querySelector('#timelineOpen');
const timelineCount = document.querySelector('#timelineCount');
const timelineModal = document.querySelector('#timelineModal');
const timelineClose = document.querySelector('#timelineClose');
const timelineSummary = document.querySelector('#timelineSummary');
const timelineList = document.querySelector('#timelineList');
let agentHistory = [];
let agentProfiles = {};
try {
  agentProfiles = JSON.parse(
    localStorage.getItem('rirei-agent-profiles') || '{}',
  );
} catch {
  agentProfiles = {};
}

const HOW_TO =
  'To open an agent session:\n' +
  '  1. Choose your Git project (top right).\n' +
  '  2. Click "Initialize project".\n' +
  '  3. Describe a task and click "Start task".\n' +
  '  4. Click "Run" next to Claude, Codex, or Gemini.\n\n' +
  'The agent opens in this terminal and you can type into it directly.';

// If xterm fails to load for any reason, keep the rest of the app usable.
let term = null;
let fit = null;
try {
  term = new Terminal({
    fontFamily: "'SFMono-Regular', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    theme: {
      background: '#000000',
      foreground: '#e6e6e0',
      cursor: '#a9ef72',
      selectionBackground: '#2a3320',
    },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(terminalEl);
  term.onData((data) => window.relay.terminalInput(data));
  // Clicking anywhere in the terminal returns keyboard focus to it.
  terminalEl.addEventListener('click', () => term.focus());
} catch (error) {
  output.textContent = `Terminal failed to load: ${error?.message ?? error}`;
}

function showTerminal() {
  card.classList.add('live');
  fit?.fit();
  term?.focus();
}

function showOutput() {
  card.classList.remove('live');
  showTerminalButton.hidden = !terminalRunning;
}

function syncControls() {
  const locked = terminalRunning || commandRunning;
  projectButton.disabled = locked;
  for (const button of commandButtons) button.disabled = locked;
  for (const button of interactiveButtons) button.disabled = locked;
  for (const button of profileButtons) button.disabled = locked;
  usageBtn.disabled = commandRunning;
  dashboardRefreshButton.disabled = commandRunning;
  stopButton.disabled = !terminalRunning;
  showTerminalButton.hidden =
    !terminalRunning || card.classList.contains('live');
}

function renderDashboardList(element, items, empty, alert = false) {
  element.textContent = '';
  const visible = items.slice(0, 2);
  if (visible.length === 0) visible.push({ description: empty });
  for (const item of visible) {
    const entry = document.createElement('li');
    entry.textContent = item.description ?? item.summary ?? empty;
    if (alert && items.length > 0) entry.className = 'alert';
    element.append(entry);
  }
  if (items.length > visible.length) {
    const more = document.createElement('li');
    more.textContent = `+${items.length - visible.length} more`;
    element.append(more);
  }
}

function renderDashboard(data) {
  dashboardTitle.textContent = data.task.title;
  dashboardStatus.textContent = data.task.status;
  dashboardStatus.className = `status-pill ${data.task.status}`;
  dashboardAgent.textContent = data.currentAgent ?? 'None';
  dashboardBranch.textContent = data.git.currentBranch;
  dashboardChanges.textContent = data.git.dirty
    ? `${data.git.changedFiles} changed`
    : 'Clean';
  dashboardCheckpoint.textContent = data.latestCheckpoint
    ? relTime(data.latestCheckpoint.createdAt)
    : 'None';
  dashboardTest.textContent = data.latestTest
    ? `${data.latestTest.status} · ${relTime(data.latestTest.createdAt)}`
    : 'Not run';
  renderDashboardList(
    dashboardRemaining,
    data.remainingWork,
    'No remaining items recorded',
  );
  renderDashboardList(
    dashboardDecisions,
    data.decisions,
    'No decisions recorded',
  );
  renderDashboardList(dashboardBlockers, data.blockers, 'No blockers', true);
  agentHistory = Array.isArray(data.agentHistory) ? data.agentHistory : [];
  timelineCount.textContent = String(agentHistory.length);
  if (!timelineModal.hidden) renderTimeline(agentHistory);
}

function renderDashboardUnavailable(message) {
  dashboardTitle.textContent = project
    ? 'No Relay task loaded'
    : 'No project selected';
  dashboardStatus.textContent = project ? 'Not started' : 'Idle';
  dashboardStatus.className = 'status-pill';
  dashboardAgent.textContent = '—';
  dashboardBranch.textContent = '—';
  dashboardChanges.textContent = '—';
  dashboardCheckpoint.textContent = '—';
  dashboardTest.textContent = '—';
  renderDashboardList(dashboardRemaining, [], message);
  renderDashboardList(dashboardDecisions, [], 'No decisions recorded');
  renderDashboardList(dashboardBlockers, [], 'No blockers');
  agentHistory = [];
  timelineCount.textContent = '0';
  if (!timelineModal.hidden) renderTimeline(agentHistory);
}

async function refreshDashboard() {
  if (!project) {
    renderDashboardUnavailable('Choose a project to begin');
    return;
  }
  dashboard.classList.add('loading');
  try {
    const result = await window.relay.dashboard({ project });
    if (result.ok) renderDashboard(result.data);
    else renderDashboardUnavailable('Initialize and start a task');
  } finally {
    dashboard.classList.remove('loading');
  }
}

function syncSize() {
  if (!term || !fit || !card.classList.contains('live')) return;
  fit.fit();
  window.relay.resizeTerminal({ cols: term.cols, rows: term.rows });
}

function showProject() {
  projectName.textContent = project
    ? project.split('/').filter(Boolean).pop()
    : 'Choose folder';
  projectName.title = project;
}

function show(result) {
  signal.className = result.ok ? 'ok' : 'error';
  output.textContent =
    result.output || (result.ok ? 'Command completed.' : 'Command failed.');
}

async function execute(command) {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  if (terminalRunning)
    return show({
      ok: false,
      output: 'Stop the active agent before running task commands.',
    });
  if (commandRunning) return;
  commandRunning = true;
  syncControls();
  showOutput();
  output.textContent = `Running relay ${command}...`;
  const value =
    command === 'start'
      ? document.querySelector('#task').value
      : document.querySelector('#checkpoint').value;
  try {
    const result = await window.relay.command({
      project,
      command,
      value,
      allowDirty: document.querySelector('#dirty').checked,
    });
    show(result);
    await refreshDashboard();
  } finally {
    commandRunning = false;
    syncControls();
  }
}

document.querySelector('#choose').addEventListener('click', async () => {
  if (terminalRunning || commandRunning) return;
  const selected = await window.relay.selectProject();
  if (!selected) return;
  project = selected;
  localStorage.setItem('relay-project', project);
  showProject();
  showOutput();
  output.textContent =
    'Project selected. Initialize or start a task to continue.';
  await refreshDashboard();
});
document
  .querySelectorAll('[data-command]')
  .forEach((button) =>
    button.addEventListener('click', () => execute(button.dataset.command)),
  );
document.querySelectorAll('[data-interactive]').forEach((button) =>
  button.addEventListener('click', async () => {
    const agent = button.dataset.agent;
    if (!term)
      return show({
        ok: false,
        output: 'Terminal is unavailable in this build.',
      });
    if (!project)
      return show({ ok: false, output: 'Choose a project folder first.' });
    if (terminalRunning)
      return show({
        ok: false,
        output: 'A terminal session is already running. Stop it first.',
      });
    // Reveal and size the terminal before launching so the PTY starts correctly.
    term.reset();
    showTerminal();
    term.write(`\x1b[90mLaunching ${agent}…\x1b[0m\r\n`);
    commandRunning = true;
    syncControls();
    try {
      const profile = agentProfiles[agent] ?? {};
      const result = await window.relay.interactive({
        project,
        command: button.dataset.interactive,
        agent,
        model: profile.model,
        effort: profile.effort,
        size: { cols: term.cols, rows: term.rows },
      });
      if (result.ok) {
        terminalRunning = true;
        signal.className = 'ok';
        term.focus();
        setTimeout(refreshDashboard, 250);
      } else {
        // Surface why it could not start (not initialized, no task, not installed…).
        showOutput();
        show(result);
      }
    } finally {
      commandRunning = false;
      syncControls();
    }
  }),
);
document.querySelector('#clear').addEventListener('click', () => {
  if (card.classList.contains('live')) {
    term?.clear();
    return;
  }
  output.textContent = HOW_TO;
  signal.className = '';
});
document.querySelector('#stop').addEventListener('click', async () => {
  if (!terminalRunning) {
    show({ ok: false, output: 'No terminal session is running.' });
    return;
  }
  await window.relay.stopTerminal();
});
showTerminalButton.addEventListener('click', () => {
  showTerminal();
  syncControls();
});
dashboardRefreshButton.addEventListener('click', refreshDashboard);

/* ---- durable agent session timeline ---- */
function formatSessionTime(iso) {
  if (!iso) return '—';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return 'Unknown';
  return value.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(startedAt, endedAt) {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 'Unknown';
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function displayAgent(agent) {
  const names = {
    claude: 'Claude',
    codex: 'Codex',
    gemini: 'Gemini',
    antigravity: 'Antigravity',
  };
  return names[agent] ?? agent ?? 'Unknown agent';
}

function displayExitReason(reason) {
  if (!reason) return 'Result unknown';
  return reason
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function timelineTone(run) {
  if (!run.endedAt) return 'active';
  if (run.exitReason === 'completed') return 'completed';
  if (run.exitReason === 'user_cancelled') return 'cancelled';
  return 'failed';
}

function renderTimeline(runs) {
  timelineList.textContent = '';
  timelineSummary.textContent =
    runs.length === 0
      ? 'No agent sessions recorded for this task.'
      : `${runs.length} ${runs.length === 1 ? 'session' : 'sessions'} recorded · newest first`;

  for (const run of [...runs].reverse()) {
    const tone = timelineTone(run);
    const item = el('li', `timeline-item ${tone}`);
    const marker = el('span', 'timeline-marker');
    marker.setAttribute('aria-hidden', 'true');
    const card = el('article', 'timeline-card');
    const head = el('div', 'timeline-card-head');
    const identity = el('div', 'timeline-identity');
    identity.append(
      el('strong', null, displayAgent(run.agent)),
      el('span', 'timeline-relative', relTime(run.startedAt)),
    );
    const status = el(
      'span',
      'timeline-status',
      tone === 'active' ? 'Running' : displayExitReason(run.exitReason),
    );
    head.append(identity, status);

    const profile = el('div', 'timeline-profile');
    profile.append(
      el('span', null, `Model · ${run.model ?? 'Auto'}`),
      el('span', null, `Effort · ${run.effort ?? 'Auto'}`),
    );

    const facts = el('dl', 'timeline-facts');
    for (const [label, value] of [
      ['Started', formatSessionTime(run.startedAt)],
      ['Ended', run.endedAt ? formatSessionTime(run.endedAt) : 'Still running'],
      ['Duration', formatDuration(run.startedAt, run.endedAt)],
      [
        'Exit',
        run.endedAt
          ? `${displayExitReason(run.exitReason)}${run.exitCode == null ? '' : ` · code ${run.exitCode}`}`
          : 'Pending',
      ],
    ]) {
      const fact = el('div');
      fact.append(el('dt', null, label), el('dd', null, value));
      facts.append(fact);
    }
    card.append(head, profile, facts);
    item.append(marker, card);
    timelineList.append(item);
  }
}

function openTimeline() {
  renderTimeline(agentHistory);
  timelineModal.hidden = false;
}

function closeTimeline() {
  timelineModal.hidden = true;
}

timelineOpen.addEventListener('click', openTimeline);
timelineClose.addEventListener('click', closeTimeline);
timelineModal.addEventListener('click', (event) => {
  if (event.target === timelineModal) closeTimeline();
});
/* ---- usage panel ---- */
const usageBtn = document.querySelector('#usageBtn');
const usageModal = document.querySelector('#usageModal');
const usageClose = document.querySelector('#usageClose');
const usageGrid = document.querySelector('#usageGrid');
const usageTask = document.querySelector('#usageTask');
const usageSummary = document.querySelector('#usageSummary');

function relTime(iso) {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderUsage(data) {
  usageTask.textContent = '';
  usageTask.append(
    document.createTextNode(`${data.task.title}  `),
    el('span', null, `· ${data.task.status}`),
  );
  usageGrid.textContent = '';
  usageSummary.textContent = '';
  const reporting = data.plans.filter((plan) => plan.status !== 'unknown');
  const summary = el('div', 'plan-summary');
  summary.append(
    el('strong', null, `${reporting.length}/${data.plans.length}`),
    el('span', null, 'providers reporting'),
  );
  usageSummary.append(summary);
  for (const plan of data.plans) {
    const card = el('div', `usage-card plan-card ${plan.status}`);
    const name = el('div', 'agent');
    name.append(el('span', 'dot'), document.createTextNode(plan.displayName));
    const statusLabels = {
      available: 'Live',
      stale: 'Stale',
      unknown: 'Unknown',
    };
    const status = el(
      'div',
      'plan-status',
      statusLabels[plan.status] ?? 'Unknown',
    );
    const windows = el('div', 'agent-windows');
    for (const [label, window] of [
      ['5-hour', plan.fiveHour],
      ['Weekly', plan.week],
    ]) {
      const row = el('div', 'window-row');
      const track = el('span', 'usage-track');
      const fill = el('span', 'usage-fill');
      const remaining = window?.remainingPercentage;
      fill.style.width = `${remaining ?? 0}%`;
      if (remaining != null && remaining < 20) fill.classList.add('critical');
      else if (remaining != null && remaining < 50)
        fill.classList.add('warning');
      track.append(fill);
      row.append(
        el('span', 'window-label', label),
        track,
        el(
          'strong',
          null,
          remaining == null ? '—' : `${Math.round(remaining)}%`,
        ),
        el(
          'small',
          null,
          window?.resetsAt
            ? `resets ${new Date(window.resetsAt).toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}`
            : 'reset unknown',
        ),
      );
      windows.append(row);
    }
    const meta = el('div', 'meta');
    meta.append(
      el('span', null, plan.detail),
      el('span', null, `source: ${plan.source}`),
      el(
        'span',
        null,
        plan.capturedAt
          ? `updated ${relTime(plan.capturedAt)}`
          : 'not reported',
      ),
    );
    card.append(name, status, windows, meta);
    usageGrid.append(card);
  }
}

async function openUsage() {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  const res = await window.relay.usage({ project });
  if (!res.ok) return show(res);
  renderUsage(res.data);
  usageModal.hidden = false;
}

function closeUsage() {
  usageModal.hidden = true;
}

usageBtn.addEventListener('click', openUsage);
usageClose.addEventListener('click', closeUsage);
usageModal.addEventListener('click', (event) => {
  if (event.target === usageModal) closeUsage();
});

/* ---- model and effort profile ---- */
const profileModal = document.querySelector('#profileModal');
const profileClose = document.querySelector('#profileClose');
const profileTitle = document.querySelector('#profileTitle');
const profileStatus = document.querySelector('#profileStatus');
const profileModel = document.querySelector('#profileModel');
const profileEffort = document.querySelector('#profileEffort');
const profileCustomRow = document.querySelector('#profileCustomRow');
const profileCustomModel = document.querySelector('#profileCustomModel');
const profilePreview = document.querySelector('#profilePreview');
const profileReset = document.querySelector('#profileReset');
const profileSave = document.querySelector('#profileSave');
let selectedProfileAgent = null;
let agentCatalogCache = null;
let selectedCatalogAgent = null;

function addOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function selectedProfileModel() {
  if (profileModel.value === '__custom')
    return profileCustomModel.value.trim() || undefined;
  return profileModel.value || undefined;
}

function updateProfilePreview() {
  const model = selectedProfileModel();
  const effort = profileEffort.value || undefined;
  const provider =
    selectedCatalogAgent?.displayName ?? selectedProfileAgent ?? 'Agent';
  profilePreview.textContent = `${provider} will launch with model ${model ?? 'Auto'} and effort ${effort ?? 'Auto'}.`;
}

function populateEfforts(preferred) {
  const model = selectedProfileModel();
  const modelOption = selectedCatalogAgent?.models?.find(
    (item) => item.id === model,
  );
  const efforts = modelOption?.efforts?.length
    ? modelOption.efforts
    : (selectedCatalogAgent?.efforts ?? []);
  profileEffort.textContent = '';
  addOption(profileEffort, '', 'Auto · provider default');
  for (const effort of efforts) addOption(profileEffort, effort, effort);
  profileEffort.disabled = efforts.length === 0;
  profileEffort.value = efforts.includes(preferred) ? preferred : '';
  updateProfilePreview();
}

async function loadAgentCatalog() {
  if (agentCatalogCache) return agentCatalogCache;
  const result = await window.relay.agentCatalog({ project });
  if (!result.ok)
    throw new Error(result.output || 'Could not load agent catalog.');
  agentCatalogCache = result.data.agents;
  return agentCatalogCache;
}

async function openProfile(agent) {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  selectedProfileAgent = agent;
  selectedCatalogAgent = null;
  profileModal.hidden = false;
  profileTitle.textContent = agent;
  profileStatus.textContent = 'Loading installed provider capabilities…';
  profileModel.disabled = true;
  profileEffort.disabled = true;
  try {
    const catalog = await loadAgentCatalog();
    selectedCatalogAgent = catalog.find((item) => item.id === agent);
    if (!selectedCatalogAgent)
      throw new Error(`No adapter found for ${agent}.`);
    profileTitle.textContent = selectedCatalogAgent.displayName;
    profileStatus.textContent = selectedCatalogAgent.installed
      ? `${selectedCatalogAgent.version ?? 'Installed'} · live model catalog`
      : 'CLI not installed · selections can be saved for later';
    const saved = agentProfiles[agent] ?? {};
    profileModel.textContent = '';
    addOption(profileModel, '', 'Auto · provider default');
    for (const model of selectedCatalogAgent.models)
      addOption(profileModel, model.id, model.label);
    addOption(profileModel, '__custom', 'Custom model ID…');
    const known = selectedCatalogAgent.models.some(
      (model) => model.id === saved.model,
    );
    profileModel.value = saved.model ? (known ? saved.model : '__custom') : '';
    profileCustomModel.value = known ? '' : (saved.model ?? '');
    profileCustomRow.hidden = profileModel.value !== '__custom';
    profileModel.disabled = false;
    populateEfforts(saved.effort);
  } catch (error) {
    profileStatus.textContent =
      error instanceof Error ? error.message : String(error);
  }
}

function closeProfile() {
  profileModal.hidden = true;
}

function updateProfileButtons() {
  for (const button of profileButtons) {
    const profile = agentProfiles[button.dataset.profileAgent] ?? {};
    button.textContent = `${profile.model ?? 'Auto'} · ${profile.effort ?? 'Auto'}`;
    button.title = button.textContent;
  }
}

for (const button of profileButtons)
  button.addEventListener('click', () =>
    openProfile(button.dataset.profileAgent),
  );
profileModel.addEventListener('change', () => {
  profileCustomRow.hidden = profileModel.value !== '__custom';
  populateEfforts(agentProfiles[selectedProfileAgent]?.effort);
  if (!profileCustomRow.hidden) profileCustomModel.focus();
});
profileCustomModel.addEventListener('input', updateProfilePreview);
profileEffort.addEventListener('change', updateProfilePreview);
profileClose.addEventListener('click', closeProfile);
profileModal.addEventListener('click', (event) => {
  if (event.target === profileModal) closeProfile();
});
profileReset.addEventListener('click', () => {
  if (!selectedProfileAgent) return;
  delete agentProfiles[selectedProfileAgent];
  localStorage.setItem('rirei-agent-profiles', JSON.stringify(agentProfiles));
  updateProfileButtons();
  closeProfile();
});
profileSave.addEventListener('click', () => {
  if (!selectedProfileAgent) return;
  const model = selectedProfileModel();
  const effort = profileEffort.value || undefined;
  agentProfiles[selectedProfileAgent] = { model, effort };
  localStorage.setItem('rirei-agent-profiles', JSON.stringify(agentProfiles));
  updateProfileButtons();
  closeProfile();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !usageModal.hidden) closeUsage();
  if (event.key === 'Escape' && !profileModal.hidden) closeProfile();
  if (event.key === 'Escape' && !timelineModal.hidden) closeTimeline();
});

window.addEventListener('resize', syncSize);
window.relay.onTerminalData((data) => term?.write(data));
window.relay.onTerminalExit(({ code, error }) => {
  terminalRunning = false;
  signal.className = code === 0 ? 'ok' : 'error';
  term?.write(
    `\r\n\x1b[90m[Relay: session ended${
      error ? `: ${error}` : ` with code ${code}`
    }]\x1b[0m\r\n`,
  );
  syncControls();
  refreshDashboard();
});

// Show the steps up front so the terminal panel explains itself.
if (!project) output.textContent = HOW_TO;
showProject();
syncControls();
refreshDashboard();
updateProfileButtons();
