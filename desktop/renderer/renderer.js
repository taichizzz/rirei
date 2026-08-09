import { TerminalTabsModel } from './terminal-tabs-model.mjs';
/* global document, localStorage, window, Terminal, FitAddon, clearTimeout, setTimeout */
const tabsModel = new TerminalTabsModel();

let project = localStorage.getItem('relay-project') || '';
const output = document.querySelector('#output');
const projectName = document.querySelector('#projectName');

const card = document.querySelector('.terminal-card');
let commandRunning = false;
let eventQueue = [];
let terminalStatusPending = true;
let deepLinkQueue = [];
let deepLinkProcessing = false;
let rendererUnloading = false;
let workspaceCreateOperationId = null;
let launchDialogPending = false;
const projectButton = document.querySelector('#choose');
const commandButtons = [...document.querySelectorAll('[data-command]')];
const interactiveButtons = [...document.querySelectorAll('[data-interactive]')];
const profileButtons = [...document.querySelectorAll('[data-profile-agent]')];
const stopButton = document.querySelector('#stop');
const openShellButton = document.querySelector('#openShell');
const showTerminalButton = document.querySelector('#showTerminal');
const hiddenTerminalsButton = document.querySelector('#hiddenTerminals');
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
const historyOpen = document.querySelector('#historyOpen');
const historyModal = document.querySelector('#historyModal');
const historyClose = document.querySelector('#historyClose');
const historySearch = document.querySelector('#historySearch');
const historyStatus = document.querySelector('#historyStatus');
const historyList = document.querySelector('#historyList');
const recoverRun = document.querySelector('#recoverRun');
const checkpointModal = document.querySelector('#checkpointModal');
const checkpointClose = document.querySelector('#checkpointClose');
const checkpointList = document.querySelector('#checkpointList');
const checkpointMeta = document.querySelector('#checkpointMeta');
const checkpointWarnings = document.querySelector('#checkpointWarnings');
const checkpointPatch = document.querySelector('#checkpointPatch');
let agentHistory = [];
let checkpoints = [];
let historyRequest = 0;
let historySearchTimer = null;
let checkpointRequest = 0;
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

function createXterm(id) {
  if (
    typeof globalThis.Terminal !== 'function' ||
    typeof globalThis.FitAddon?.FitAddon !== 'function'
  ) {
    show({ ok: false, output: 'The terminal emulator is unavailable.' });
    return null;
  }
  let t;
  let container;
  let disposable;
  try {
    t = new Terminal({
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
    const f = new FitAddon.FitAddon();
    t.loadAddon(f);

    container = document.createElement('div');
    container.className = 'terminal-instance';
    document.getElementById('terminalsContainer').appendChild(container);
    t.open(container);

    disposable = t.onData((data) => {
      window.relay.terminalInput(id, data);
    });
    const focus = () => t.focus();
    container.addEventListener('click', focus);
    return {
      terminal: t,
      fit: f,
      container,
      dispose: () => {
        disposable?.dispose();
        container?.removeEventListener('click', focus);
        t?.dispose();
        container?.remove();
      },
    };
  } catch (error) {
    disposable?.dispose();
    t?.dispose();
    container?.remove();
    show({
      ok: false,
      output: `Terminal failed to initialize: ${error?.message ?? error}`,
    });
    return null;
  }
}

function renderTabs() {
  const container = document.getElementById('terminalTabs');
  const addBtn = document.getElementById('addTerminalBtn');
  container.innerHTML = '';
  for (const t of tabsModel.getAll().filter((item) => !item.metadata.hidden)) {
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (t.id === tabsModel.activeId ? ' active' : '');

    // Status indicator
    const indicator = document.createElement('span');
    indicator.className = 'tab-indicator ' + (t.metadata.status || 'starting');

    const label = document.createElement('span');
    const provider =
      (t.metadata.provider || 'Agent').charAt(0).toUpperCase() +
      (t.metadata.provider || 'Agent').slice(1);
    label.textContent = provider + ' · ' + (t.metadata.branchLabel || 'main');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', `Close ${provider} terminal`);
    closeBtn.onclick = (event) => {
      event.stopPropagation();
      void handleCloseTab(t.id);
    };

    btn.append(indicator, label);
    btn.onclick = () => {
      tabsModel.selectTerminal(t.id);
    };
    tab.append(btn, closeBtn);
    container.append(tab);
  }
  container.append(addBtn);

  // Show active terminal container
  const termContainer = document.getElementById('terminalsContainer');
  for (const child of termContainer.children) {
    child.style.display = 'none';
  }
  const active = tabsModel.getActive();
  if (active) {
    active.container.style.display = 'block';
  }
  const hiddenCount = tabsModel.counts().hidden;
  hiddenTerminalsButton.hidden = hiddenCount === 0;
  hiddenTerminalsButton.textContent = `Hidden (${hiddenCount})`;
}
tabsModel.subscribe((event) => {
  if (event.type === 'select') {
    renderTabs();
    const active = tabsModel.getActive();
    if (active) {
      card.classList.add('live');
      document
        .querySelectorAll('.terminal-instance')
        .forEach((element) => (element.style.display = 'none'));
      active.container.style.display = 'block';
      setTimeout(syncSize, 10);
      setTimeout(() => active.terminal.focus(), 20);
    }
  } else if (event.type === 'remove') {
    renderTabs();
    if (event.removed) {
      event.removed.dispose?.();
    }
  } else {
    renderTabs();
  }
  if (!tabsModel.getActive()) card.classList.remove('live');
  syncControls();
});

function flushQueue() {
  const queued = eventQueue;
  eventQueue = [];
  for (const event of queued) applyTerminalEvent(event);
}

function applyTerminalEvent(event) {
  const terminal = tabsModel.get(event.terminalId);
  if (!terminal) {
    eventQueue.push(event);
    return;
  }
  if (event.type === 'data') {
    if (!tabsModel.updateOutputSequence(event.terminalId, event.sequence)) {
      window.relay.acknowledgeTerminalOutput(event.terminalId, event.sequence);
      return;
    }
    terminal.terminal.write(event.data, () =>
      window.relay.acknowledgeTerminalOutput(event.terminalId, event.sequence),
    );
    return;
  }
  if (event.sequence <= terminal.sequence) return;
  if (event.type === 'status') {
    tabsModel.updateMetadata(event.terminalId, {
      status: event.status,
      sequence: event.sequence,
    });
  } else if (event.type === 'exit') {
    terminal.terminal.write(
      `\r\n\x1b[90m[Relay: session ended${
        event.error ? `: ${event.error}` : ` with code ${event.code}`
      }]\x1b[0m\r\n`,
    );
    tabsModel.updateMetadata(event.terminalId, {
      status: event.status,
      exitCode: event.code,
      signal: event.signal,
      error: event.error,
      sequence: event.sequence,
    });
    syncControls();
    void refreshDashboard();
  }
}

function receiveTerminalEvent(event) {
  if (terminalStatusPending || !tabsModel.get(event.terminalId)) {
    eventQueue.push(event);
    return;
  }
  applyTerminalEvent(event);
}

function showMissingTerminal(terminalId) {
  const message = `Terminal ${terminalId} was not found. It may have ended or been closed.`;
  showOutput();
  show({ ok: false, output: message });
  openTimeline();
  timelineSummary.textContent = message;
  timelineClose.focus();
}

async function applyDeepLink(intent) {
  if (
    !intent ||
    typeof intent.terminalId !== 'string' ||
    !['terminal', 'not-found'].includes(intent.type)
  )
    return;
  if (intent.type === 'not-found') {
    showMissingTerminal(intent.terminalId);
    return;
  }

  const terminal = tabsModel.get(intent.terminalId);
  if (!terminal) {
    showMissingTerminal(intent.terminalId);
    return;
  }
  if (terminal.metadata.hidden) {
    const result = await window.relay.showTerminalTab(terminal.id);
    if (!result?.ok) {
      showMissingTerminal(intent.terminalId);
      return;
    }
    tabsModel.setHidden(terminal.id, false);
  }
  if (!tabsModel.selectTerminal(terminal.id)) {
    showMissingTerminal(intent.terminalId);
    return;
  }
  showTerminal();
}

async function flushDeepLinkQueue() {
  if (terminalStatusPending || deepLinkProcessing) return;
  deepLinkProcessing = true;
  try {
    while (deepLinkQueue.length > 0) {
      const intent = deepLinkQueue.shift();
      try {
        await applyDeepLink(intent);
      } catch (error) {
        if (!rendererUnloading)
          show({
            ok: false,
            output: `Could not open terminal link: ${error?.message ?? error}`,
          });
      }
    }
  } finally {
    deepLinkProcessing = false;
  }
}

function receiveDeepLink(intent) {
  deepLinkQueue = [
    ...deepLinkQueue.filter(
      (candidate) => candidate.terminalId !== intent?.terminalId,
    ),
    intent,
  ].slice(-32);
  void flushDeepLinkQueue();
}

let tabToClose = null;
async function handleCloseTab(id) {
  const t = tabsModel.get(id);
  if (!t) return;
  if (
    ['completed', 'failed', 'cancelled', 'orphaned'].includes(t.metadata.status)
  ) {
    const result = await window.relay.closeTerminal(id);
    if (result?.ok) tabsModel.removeTerminal(id);
  } else {
    tabToClose = id;
    document.getElementById('closeTabModal').hidden = false;
    document.getElementById('closeTabCancel').focus();
  }
}
document.getElementById('closeTabHide').onclick = async () => {
  if (tabToClose) {
    const result = await window.relay.hideTerminal(tabToClose);
    if (result?.ok) tabsModel.setHidden(tabToClose, true);
    tabToClose = null;
  }
  document.getElementById('closeTabModal').hidden = true;
  const active = tabsModel.getActive();
  if (active) active.terminal.focus();
  else hiddenTerminalsButton.focus();
};

hiddenTerminalsButton.onclick = async () => {
  const hidden = tabsModel
    .getAll()
    .filter((terminal) => terminal.metadata.hidden);
  for (const terminal of hidden) {
    const result = await window.relay.showTerminalTab(terminal.id);
    if (result?.ok) tabsModel.setHidden(terminal.id, false);
  }
  const restored = hidden.at(-1);
  if (restored) tabsModel.selectTerminal(restored.id);
};
document.getElementById('closeTabInterrupt').onclick = async () => {
  const terminal = tabToClose ? tabsModel.get(tabToClose) : null;
  if (tabToClose) {
    await window.relay.interruptTerminal(tabToClose);
    tabToClose = null;
  }
  document.getElementById('closeTabModal').hidden = true;
  terminal?.terminal.focus();
};
document.getElementById('closeTabCancel').onclick = () => {
  const terminal = tabToClose ? tabsModel.get(tabToClose) : null;
  tabToClose = null;
  document.getElementById('closeTabModal').hidden = true;
  terminal?.terminal.focus();
};

// Launch Dialog
const launchDialogModal = document.getElementById('launchDialogModal');
document.getElementById('addTerminalBtn').onclick = async () => {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  if (terminalStatusPending || launchDialogPending || commandRunning) return;
  launchDialogPending = true;
  document.getElementById('addTerminalBtn').disabled = true;
  workspaceCreateOperationId = window.crypto.randomUUID();

  try {
    document.getElementById('launchProvider').value = 'claude';
    document.getElementById('launchRole').value = 'implement';
    document.getElementById('launchSlug').value = '';
    document.getElementById('launchRoleRow').hidden = true;
    document.getElementById('launchSlugRow').hidden = true;

    const requestedProject = project;
    const workspaces = await window.relay.workspaceList({
      project: requestedProject,
    });
    if (project !== requestedProject) return;
    if (!workspaces.ok) {
      show(workspaces);
      return;
    }
    const choice = document.getElementById('launchWorkspaceChoice');
    choice.textContent = '';
    const main = document.createElement('option');
    main.value = '__main';
    main.textContent = workspaces.data.mainClaimed
      ? 'Main working tree (in use)'
      : 'Main working tree';
    main.disabled = workspaces.data.mainClaimed;
    const create = document.createElement('option');
    create.value = '__create';
    create.textContent = 'Create isolated workspace';
    choice.append(main, create);
    for (const workspace of workspaces.data.workspaces) {
      const option = document.createElement('option');
      option.value = workspace.id;
      option.textContent = `${workspace.branchLabel} · ${workspace.role}${
        workspace.claimed ? ' (in use)' : ''
      }`;
      option.disabled = !workspace.selectable;
      choice.appendChild(option);
    }
    choice.value = main.disabled ? '__create' : '__main';
    document.getElementById('launchRoleRow').hidden =
      choice.value !== '__create';
    document.getElementById('launchSlugRow').hidden =
      choice.value !== '__create';
    launchDialogModal.hidden = false;
    document.getElementById('launchProvider').focus();
  } finally {
    launchDialogPending = false;
    document.getElementById('addTerminalBtn').disabled = false;
  }
};
document.getElementById('launchDialogClose').onclick = () => {
  launchDialogModal.hidden = true;
  document.getElementById('addTerminalBtn').focus();
};
document.getElementById('launchWorkspaceChoice').onchange = (e) => {
  const val = e.target.value;
  document.getElementById('launchRoleRow').hidden = val !== '__create';
  document.getElementById('launchSlugRow').hidden = val !== '__create';
};
document.getElementById('launchDialogRun').onclick = async () => {
  if (launchDialogPending || commandRunning) return;
  launchDialogPending = true;
  document.getElementById('launchDialogRun').disabled = true;
  const provider = document.getElementById('launchProvider').value;
  let workspace = document.getElementById('launchWorkspaceChoice').value;
  if (workspace === '__main') workspace = undefined;

  try {
    if (workspace === '__create') {
      const role = document.getElementById('launchRole').value;
      const slug = document.getElementById('launchSlug').value;
      const res = await window.relay.workspaceCreate({
        project,
        role,
        slug,
        operationId: workspaceCreateOperationId ?? window.crypto.randomUUID(),
      });
      if (!res.ok) {
        show(res);
        return;
      }
      workspace = res.data.id;
    }

    const launched = await launchInteractive('run', provider, { workspace });
    if (launched) launchDialogModal.hidden = true;
  } finally {
    launchDialogPending = false;
    document.getElementById('launchDialogRun').disabled = false;
  }
};

function showTerminal() {
  card.classList.add('live');
  const active = tabsModel.getActive();
  if (!active) return;
  active.container.style.display = 'block';
  syncSize();
  active.terminal.focus();
}

function showOutput() {
  card.classList.remove('live');
  showTerminalButton.hidden = tabsModel.getAll().length === 0;
}

function syncControls() {
  const counts = tabsModel.counts();
  const running = counts.running > 0;
  showTerminalButton.hidden = counts.total === 0;
  hiddenTerminalsButton.hidden = counts.hidden === 0;
  hiddenTerminalsButton.textContent = `Hidden (${counts.hidden})`;
  const locked = running || commandRunning;

  projectButton.disabled = locked;
  for (const button of commandButtons) button.disabled = locked || !project;
  for (const button of interactiveButtons)
    button.disabled = locked || !project || terminalStatusPending;
  for (const button of profileButtons) button.disabled = locked || !project;
  document.getElementById('addTerminalBtn').disabled =
    commandRunning || !project || terminalStatusPending;
  openShellButton.disabled =
    commandRunning || !project || terminalStatusPending || counts.running >= 4;
  const active = tabsModel.getActive();
  stopButton.disabled =
    !active ||
    !['starting', 'running', 'waiting', 'stopping'].includes(
      active.metadata.status,
    );
  if (locked) {
    recoverRun.hidden = true;
  } else {
    recoverRun.hidden = !window.hasRecoverableRun;
  }
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
  checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
  dashboardCheckpoint.disabled = checkpoints.length === 0;
  dashboardCheckpoint.title = checkpoints.length
    ? `View ${checkpoints.length} retained checkpoint${checkpoints.length === 1 ? '' : 's'}`
    : 'No retained checkpoints';
  window.hasRecoverableRun =
    (Array.isArray(data.runs) && data.runs.length > 0) ||
    (Array.isArray(data.agentHistory) &&
      data.agentHistory.some((run) => !run.endedAt));
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
  syncControls();
}

function renderDashboardUnavailable(message) {
  window.hasRecoverableRun = false;
  dashboardTitle.textContent = project
    ? 'No Relay task loaded'
    : 'No project selected';
  dashboardStatus.textContent = project ? 'Not started' : 'Idle';
  dashboardStatus.className = 'status-pill';
  dashboardAgent.textContent = '—';
  dashboardBranch.textContent = '—';
  dashboardChanges.textContent = '—';
  dashboardCheckpoint.textContent = '—';
  dashboardCheckpoint.disabled = true;
  checkpoints = [];
  recoverRun.hidden = true;
  dashboardTest.textContent = '—';
  renderDashboardList(dashboardRemaining, [], message);
  renderDashboardList(dashboardDecisions, [], 'No decisions recorded');
  renderDashboardList(dashboardBlockers, [], 'No blockers');
  agentHistory = [];
  timelineCount.textContent = '0';
  if (!timelineModal.hidden) renderTimeline(agentHistory);
  syncControls();
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
  const active = tabsModel.getActive();
  if (!active || !card.classList.contains('live')) return;
  active.fit.fit();
  window.relay.resizeTerminal(active.id, {
    cols: active.terminal.cols,
    rows: active.terminal.rows,
  });
}

function showProject() {
  projectName.textContent = project
    ? project.split('/').filter(Boolean).pop()
    : 'Choose folder';
  projectName.title = project;
}

function show(result) {
  output.textContent =
    result.output || (result.ok ? 'Command completed.' : 'Command failed.');
}

async function execute(command) {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  if (tabsModel.counts().running > 0)
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
  if (tabsModel.counts().running > 0 || commandRunning) return;
  const selected = await window.relay.selectProject();
  if (!selected) return;
  project = selected;
  localStorage.setItem('relay-project', project);
  window.relay.setActiveProject(project);
  syncControls();
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
async function launchInteractive(command, agent, resume = {}) {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  if (commandRunning || terminalStatusPending) return false;
  if (tabsModel.counts().running >= 4)
    return show({
      ok: false,
      output: 'Maximum of 4 running terminals reached.',
    });

  commandRunning = true;
  syncControls();
  try {
    const profile = agentProfiles[agent] ?? {};

    const result = await window.relay.interactive({
      project,
      command,
      agent,
      model: profile.model,
      effort: profile.effort,
      resumeTargetKind: resume.kind ?? 'picker',
      resumeTargetValue: resume.value,
      fork: resume.fork === true,
      workspace: resume.workspace,
      size: {
        cols: 80,
        rows: 24,
      },
    });

    if (result.ok) {
      if (result.terminal) factory(result.terminal);
      tabsModel.selectTerminal(result.terminalId);
      showTerminal();
      flushQueue();
      setTimeout(refreshDashboard, 250);
      return true;
    } else {
      showOutput();
      show(result);
      return false;
    }
  } finally {
    commandRunning = false;
    syncControls();
  }
}

for (const button of interactiveButtons)
  button.addEventListener('click', () =>
    launchInteractive(button.dataset.interactive, button.dataset.agent),
  );
document.querySelector('#clear').addEventListener('click', () => {
  if (card.classList.contains('live')) {
    tabsModel.getActive()?.terminal.clear();
    return;
  }
  output.textContent = HOW_TO;
});
document.querySelector('#stop').addEventListener('click', async () => {
  const active = tabsModel.getActive();
  if (
    !active ||
    active.metadata.status === 'completed' ||
    ['completed', 'failed', 'cancelled', 'orphaned'].includes(
      active.metadata.status,
    )
  ) {
    show({ ok: false, output: 'No running terminal session selected.' });
    return;
  }
  await window.relay.stopTerminal(active.id);
});
showTerminalButton.addEventListener('click', () => {
  showTerminal();
  syncControls();
});
openShellButton.addEventListener('click', async () => {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  if (commandRunning || terminalStatusPending) return;
  if (tabsModel.counts().running >= 4)
    return show({
      ok: false,
      output: 'Close or stop a terminal before opening another one.',
    });
  commandRunning = true;
  syncControls();
  try {
    const result = await window.relay.openShell({
      project,
      size: { cols: 100, rows: 30 },
    });
    if (!result.ok) {
      show(result);
      return;
    }
    if (result.terminal) factory(result.terminal);
    tabsModel.selectTerminal(result.terminalId);
    showTerminal();
    flushQueue();
  } catch (error) {
    show({
      ok: false,
      output: `Could not open shell: ${error?.message ?? error}`,
    });
  } finally {
    commandRunning = false;
    syncControls();
  }
});
dashboardRefreshButton.addEventListener('click', refreshDashboard);
recoverRun.addEventListener('click', async () => {
  await execute('recover');
});

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

/* ---- archived task history ---- */
function renderHistory(entries) {
  historyList.textContent = '';
  historyStatus.textContent = `${entries.length} ${entries.length === 1 ? 'task' : 'tasks'} found`;
  for (const entry of entries) {
    const item = el('li', 'history-item');
    const head = el('div', 'history-item-head');
    head.append(
      el('strong', null, entry.title),
      el(
        'span',
        'history-task-status',
        entry.current ? 'Current' : entry.status,
      ),
    );
    const meta = el(
      'p',
      'history-item-meta',
      `${formatSessionTime(entry.updatedAt)} · ${entry.runs.length} agent ${entry.runs.length === 1 ? 'run' : 'runs'} · ${entry.checkpoints.length} checkpoints`,
    );
    const runs = el('div', 'history-runs');
    for (const run of entry.runs) {
      const runRow = el('div', 'history-run');
      runRow.append(
        el(
          'span',
          null,
          `${displayAgent(run.provider)} · ${run.model ?? 'Auto'} · ${displayExitReason(run.exitReason)}`,
        ),
      );
      if (run.providerSessionId && ['claude', 'codex'].includes(run.provider)) {
        const resume = el('button', null, 'Resume');
        resume.addEventListener('click', () => {
          closeHistory();
          launchInteractive('resume', run.provider, {
            kind: 'id',
            value: run.providerSessionId,
          });
        });
        runRow.append(resume);
      }
      runs.append(runRow);
    }
    item.append(head, meta, runs);
    historyList.append(item);
  }
}

async function loadHistory() {
  if (!project) return;
  const request = ++historyRequest;
  historyStatus.textContent = 'Searching…';
  const result = await window.relay.history({
    project,
    query: historySearch.value,
  });
  if (request !== historyRequest) return;
  if (!result.ok) {
    historyStatus.textContent = result.output || 'Could not read task history.';
    historyList.textContent = '';
    return;
  }
  renderHistory(Array.isArray(result.data) ? result.data : []);
}

function openHistory() {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  historyModal.hidden = false;
  historySearch.focus();
  loadHistory();
}

function closeHistory() {
  historyModal.hidden = true;
  historyRequest += 1;
  historyOpen.focus();
}

historyOpen.addEventListener('click', openHistory);
historyClose.addEventListener('click', closeHistory);
historyModal.addEventListener('click', (event) => {
  if (event.target === historyModal) closeHistory();
});
historySearch.addEventListener('input', () => {
  if (historySearchTimer) clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(loadHistory, 160);
});

/* ---- checkpoint diff viewer ---- */
function renderCheckpointList(items) {
  checkpointList.textContent = '';
  for (const item of [...items].reverse()) {
    const row = el('li');
    const button = el(
      'button',
      null,
      item.label || formatSessionTime(item.createdAt),
    );
    button.title = item.id;
    button.addEventListener('click', () => loadCheckpointDiff(item.id, button));
    row.append(button);
    checkpointList.append(row);
  }
}

async function loadCheckpointDiff(id, selectedButton) {
  const request = ++checkpointRequest;
  for (const button of checkpointList.querySelectorAll('button'))
    button.classList.toggle('selected', button === selectedButton);
  checkpointMeta.textContent = 'Loading checkpoint…';
  checkpointWarnings.textContent = '';
  checkpointPatch.textContent = '';
  const result = await window.relay.checkpointDiff({ project, id });
  if (request !== checkpointRequest || checkpointModal.hidden) return;
  if (!result.ok) {
    checkpointMeta.textContent = result.output || 'Could not read checkpoint.';
    return;
  }
  const data = result.data;
  checkpointMeta.textContent = `${data.metadata.label ?? 'Checkpoint'} · ${formatSessionTime(data.metadata.createdAt)} · ${data.metadata.branch} · ${data.metadata.commit}`;
  checkpointWarnings.textContent = (data.warnings ?? []).join('\n');
  checkpointPatch.textContent =
    data.patch || data.diffStat || data.status || '(No saved text patch.)';
}

async function openCheckpointViewer() {
  if (!project || checkpoints.length === 0) return;
  checkpointModal.hidden = false;
  checkpointMeta.textContent = 'Loading checkpoints…';
  checkpointWarnings.textContent = '';
  checkpointPatch.textContent = '';
  const result = await window.relay.checkpoints({ project });
  if (!result.ok) {
    checkpointMeta.textContent =
      result.output || 'Could not read checkpoint history.';
    return;
  }
  const items = Array.isArray(result.data?.checkpoints)
    ? result.data.checkpoints
    : [];
  renderCheckpointList(items);
  const firstButton = checkpointList.querySelector('button');
  const newest = items.at(-1);
  if (newest && firstButton) loadCheckpointDiff(newest.id, firstButton);
  (firstButton ?? checkpointClose).focus();
}

function closeCheckpointViewer() {
  checkpointModal.hidden = true;
  checkpointRequest += 1;
  dashboardCheckpoint.focus();
}

dashboardCheckpoint.addEventListener('click', openCheckpointViewer);
checkpointClose.addEventListener('click', closeCheckpointViewer);
checkpointModal.addEventListener('click', (event) => {
  if (event.target === checkpointModal) closeCheckpointViewer();
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
  if (event.key === 'Escape' && !launchDialogModal.hidden) {
    launchDialogModal.hidden = true;
    document.getElementById('addTerminalBtn').focus();
  }
  if (
    event.key === 'Escape' &&
    !document.getElementById('closeTabModal').hidden
  )
    document.getElementById('closeTabCancel').click();
  const modal = Array.from(document.querySelectorAll('.modal')).find(
    (candidate) => !candidate.hidden,
  );
  if (event.key === 'Tab' && modal) {
    const focusable = Array.from(
      modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  if (event.key === 'Escape' && !usageModal.hidden) closeUsage();
  if (event.key === 'Escape' && !profileModal.hidden) closeProfile();
  if (event.key === 'Escape' && !timelineModal.hidden) closeTimeline();
  if (event.key === 'Escape' && !historyModal.hidden) closeHistory();
  if (event.key === 'Escape' && !checkpointModal.hidden)
    closeCheckpointViewer();
});

window.addEventListener('resize', syncSize);
const removeTerminalDataListener = window.relay.onTerminalData((event) =>
  receiveTerminalEvent({ ...event, type: 'data' }),
);
const removeTerminalStatusListener = window.relay.onTerminalStatus((event) => {
  receiveTerminalEvent({ ...event, type: 'status' });
  syncControls();
});
const removeTerminalExitListener = window.relay.onTerminalExit((event) =>
  receiveTerminalEvent({ ...event, type: 'exit' }),
);
const removeUsageUpdateListener = window.relay.onUsageUpdate((data) => {
  if (!usageModal.hidden) renderUsage(data);
});
const removeDeepLinkListener = window.relay.onDeepLink(receiveDeepLink);

// Show the steps up front so the terminal panel explains itself.
if (!project) output.textContent = HOW_TO;
window.relay.setActiveProject(project || null);
showProject();
syncControls();
void refreshDashboard().catch(() =>
  renderDashboardUnavailable('Could not read project status'),
);
updateProfileButtons();

function factory(item) {
  if (tabsModel.get(item.id)) return tabsModel.get(item.id);
  const instances = createXterm(item.id);
  if (!instances) return null;
  const added = tabsModel.addTerminal(
    item.id,
    item,
    instances.terminal,
    instances.fit,
    instances.container,
    instances.dispose,
  );
  if (!added) {
    instances.dispose();
    return tabsModel.get(item.id);
  }
  if (item.buffer) instances.terminal.write(item.buffer);
  window.relay.acknowledgeTerminalOutput(item.id, item.sequence);
  return tabsModel.get(item.id);
}

void window.relay
  .terminalInventory()
  .then((inventory) => {
    tabsModel.reconcileInventory(inventory, factory);
    terminalStatusPending = false;
    flushQueue();
    syncControls();
    window.relay.rendererReady();
    void flushDeepLinkQueue();
  })
  .catch((error) => {
    show({
      ok: false,
      output: `Could not restore terminals: ${error?.message ?? error}`,
    });
  })
  .finally(() => {
    terminalStatusPending = false;
    syncControls();
  });

window.addEventListener('unload', () => {
  rendererUnloading = true;
  removeTerminalDataListener?.();
  removeTerminalStatusListener?.();
  removeTerminalExitListener?.();
  removeUsageUpdateListener?.();
  removeDeepLinkListener?.();
  deepLinkQueue = [];
  for (const terminal of tabsModel.getAll()) terminal.dispose?.();
});
