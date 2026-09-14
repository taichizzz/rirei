import { TerminalTabsModel } from './terminal-tabs-model.mjs';
import { LatestRequestGate } from './latest-request.mjs';
import {
  deriveProviderReadiness,
  effortsForModel,
  formatExactTimestamp,
  launchProfileOverrides,
  planStatusLabel,
  selectedModelValue,
  usageWindowPresentation,
} from './provider-ui.mjs';
/* global document, localStorage, window, Terminal, FitAddon */
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
let projectInitializing = true;
let projectChoicePending = false;
const projectButton = document.querySelector('#choose');
const commandButtons = [...document.querySelectorAll('[data-command]')];
const interactiveButtons = [...document.querySelectorAll('[data-interactive]')];
const profileButtons = [...document.querySelectorAll('[data-profile-agent]')];
const stopButton = document.querySelector('#stop');
const stopAllButton = document.querySelector('#stopAll');
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
const threadsOpen = document.querySelector('#threadsOpen');
const threadsBadge = document.querySelector('#threadsBadge');
const threadsModal = document.querySelector('#threadsModal');
const threadsClose = document.querySelector('#threadsClose');
const threadsNewBtn = document.querySelector('#threadsNewBtn');
const threadsFilter = document.querySelector('#threadsFilter');
const threadsList = document.querySelector('#threadsList');
const attentionList = document.querySelector('#attentionList');
const threadEmptyState = document.querySelector('#threadEmptyState');
const threadMessagesContainer = document.querySelector(
  '#threadMessagesContainer',
);
const threadHeader = document.querySelector('#threadHeader');
const threadMessagesList = document.querySelector('#threadMessagesList');
const threadReplyForm = document.querySelector('#threadReplyForm');
const threadReplyBody = document.querySelector('#threadReplyBody');
const threadReplyRedact = document.querySelector('#threadReplyRedact');
const threadComposerContainer = document.querySelector(
  '#threadComposerContainer',
);
const threadNewForm = document.querySelector('#threadNewForm');
const composerTo = document.querySelector('#composerTo');
const composerIntent = document.querySelector('#composerIntent');
const composerDelivery = document.querySelector('#composerDelivery');
const composerDeliveryHint = document.querySelector('#composerDeliveryHint');
const composerBody = document.querySelector('#composerBody');
const composerRedact = document.querySelector('#composerRedact');
const composerTokenEstimate = document.querySelector('#composerTokenEstimate');
const composerCancel = document.querySelector('#composerCancel');
let currentThreadId = null;
let currentThreadReplyToId = null;
let threadsFilterTimer = null;
let authoritativeUnread = 0;
let sendMessagePending = false;
let replyMessagePending = false;
let sendOperationId = null;
let replyOperationId = null;
let messageDeliveryCatalog = [];
const threadsRequestGate = new LatestRequestGate();
const threadRequestGate = new LatestRequestGate();
const recoverRun = document.querySelector('#recoverRun');
const resumeRecovered = document.querySelector('#resumeRecovered');
const checkpointModal = document.querySelector('#checkpointModal');
const checkpointClose = document.querySelector('#checkpointClose');
const checkpointList = document.querySelector('#checkpointList');
const checkpointMeta = document.querySelector('#checkpointMeta');
const checkpointWarnings = document.querySelector('#checkpointWarnings');
const checkpointPatch = document.querySelector('#checkpointPatch');
const onboardingModal = document.querySelector('#onboardingModal');
const onboardingSkip = document.querySelector('#onboardingSkip');
const onboardingChoose = document.querySelector('#onboardingChoose');
const onboardingContinue = document.querySelector('#onboardingContinue');
const onboardingProjectName = document.querySelector('#onboardingProjectName');
const onboardingProjectPath = document.querySelector('#onboardingProjectPath');
const onboardingProjectStep = document.querySelector('#onboardingProjectStep');
const onboardingProviderStep = document.querySelector(
  '#onboardingProviderStep',
);
const onboardingUsageStep = document.querySelector('#onboardingUsageStep');
const onboardingChecks = document.querySelector('#onboardingChecks');
const onboardingStatus = document.querySelector('#onboardingStatus');
const onboardingProviders = document.querySelector('#onboardingProviders');
const onboardingError = document.querySelector('#onboardingError');
let agentHistory = [];
let activitySessions = [];
let threadTimeline = [];
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
      // The canvas would paint an opaque slab over the translucent window, so
      // it stays clear and #terminalsContainer's --terminal scrim shows
      // through instead. This costs xterm's opaque-background fast path; set
      // this back to false and background to '#080a09' to trade the look for
      // that throughput.
      allowTransparency: true,
      theme: {
        background: 'rgba(0, 0, 0, 0)',
        foreground: '#f2f2ee',
        cursor: '#f2f2ee',
        cursorAccent: '#000000',
        selectionBackground: '#333333',
        black: '#000000',
        brightBlack: '#858580',
        green: '#a7d45d',
        brightGreen: '#cdf875',
        yellow: '#e6ba62',
        brightYellow: '#f3d28a',
        red: '#ee907e',
        brightRed: '#ffad9d',
        blue: '#8cbcff',
        brightBlue: '#b2d2ff',
      },
    });
    const f = new FitAddon.FitAddon();
    t.loadAddon(f);

    container = document.createElement('div');
    container.className = 'terminal-instance';
    document.getElementById('terminalsContainer').appendChild(container);
    t.open(container);

    disposable = t.onData((data) => {
      const tab = tabsModel.get(id);
      if (tab?.metadata?.readOnly) return;
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(data.length, offset + 16 * 1024);
        const lastCodeUnit = data.charCodeAt(end - 1);
        if (
          end < data.length &&
          lastCodeUnit >= 0xd800 &&
          lastCodeUnit <= 0xdbff
        )
          end -= 1;
        window.relay.terminalInput(id, data.slice(offset, end));
        offset = end;
      }
    });
    const bellDisposable = t.onBell(() => {
      window.relay.terminalAttention(id);
    });
    const focus = () => t.focus();
    container.addEventListener('click', focus);
    return {
      terminal: t,
      fit: f,
      container,
      dispose: () => {
        disposable?.dispose();
        bellDisposable?.dispose();
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
    const startCursor = event.startCursor ?? terminal.outputCursor;
    const endCursor = event.endCursor ?? event.sequence;
    if (
      !Number.isSafeInteger(startCursor) ||
      !Number.isSafeInteger(endCursor) ||
      endCursor < startCursor
    )
      return;
    if (endCursor <= terminal.outputCursor) {
      window.relay.acknowledgeTerminalOutput(
        event.terminalId,
        terminal.outputCursor,
      );
      return;
    }
    const gap = event.truncated || startCursor > terminal.outputCursor;
    const bytes = event.dataBase64
      ? Uint8Array.from(atob(event.dataBase64), (character) =>
          character.charCodeAt(0),
        )
      : event.data;
    const acknowledge = () => {
      tabsModel.updateOutputSequence(event.terminalId, endCursor);
      window.relay.acknowledgeTerminalOutput(event.terminalId, endCursor);
    };
    const writeData = () => {
      if (bytes?.length) terminal.terminal.write(bytes, acknowledge);
      else acknowledge();
    };
    if (gap) {
      terminal.outputCursor = startCursor;
      terminal.terminal.write(
        '\r\n\x1b[90m[Relay: earlier terminal output is no longer available]\x1b[0m\r\n',
        writeData,
      );
    } else {
      writeData();
    }
    return;
  }
  if (
    event.sequence < terminal.sequence ||
    (event.type !== 'exit' && event.sequence === terminal.sequence)
  )
    return;
  if (event.type === 'status') {
    tabsModel.updateMetadata(event.terminalId, {
      status: event.status,
      hidden: event.hidden ?? terminal.metadata.hidden,
      dimensions: event.dimensions ?? terminal.metadata.dimensions,
      bridge: event.bridge ?? terminal.metadata.bridge,
      bridgeError: event.bridgeError ?? terminal.metadata.bridgeError,
      sequence: event.sequence,
    });
  } else if (event.type === 'exit') {
    if (terminal.exitPresented) return;
    terminal.exitPresented = true;
    const providerLabel = event.providerResult
      ? `provider ${displayExitReason(event.providerResult.reason)}`
      : 'provider result unknown';
    const bridgeLabel =
      event.bridgeStatus === 'failed' || event.bridgeError
        ? `; terminal bridge failed${event.bridgeError ? ` (${event.bridgeError})` : ''}`
        : '';
    terminal.terminal.write(
      `\r\n\x1b[90m[Relay: ${providerLabel}${bridgeLabel}]\x1b[0m\r\n`,
    );
    tabsModel.updateMetadata(event.terminalId, {
      status: event.status,
      exitCode: event.code,
      signal: event.signal,
      error: event.error,
      bridgeStatus: event.bridgeStatus,
      bridgeError: event.bridgeError,
      providerResult: event.providerResult,
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
    const result = await window.relay.stopTerminal(tabToClose);
    if (!result?.ok) show(result);
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
const launchProvider = document.getElementById('launchProvider');
const launchProviderStatus = document.getElementById('launchProviderStatus');
const launchModel = document.getElementById('launchModel');
const launchEffort = document.getElementById('launchEffort');
const launchDialogRun = document.getElementById('launchDialogRun');
const launchCustomModelRow = document.getElementById('launchCustomModelRow');
const launchCustomModel = document.getElementById('launchCustomModel');
let launchCatalog = [];

function selectedLaunchModel() {
  return selectedModelValue(launchModel.value, launchCustomModel.value);
}

function populateLaunchEfforts(preferred) {
  const entry = launchCatalog.find((item) => item.id === launchProvider.value);
  const model = selectedLaunchModel();
  const efforts = effortsForModel(entry, model);
  launchEffort.textContent = '';
  addOption(launchEffort, '', 'Auto · provider default');
  for (const effort of efforts) addOption(launchEffort, effort, effort);
  launchEffort.disabled = efforts.length === 0;
  launchEffort.value = efforts.includes(preferred) ? preferred : '';
}

function populateLaunchProvider(provider) {
  const entry = launchCatalog.find((item) => item.id === provider);
  const saved = agentProfiles[provider] ?? {};
  launchModel.textContent = '';
  addOption(launchModel, '', 'Auto · provider default');
  for (const model of entry?.models?.values ?? [])
    addOption(launchModel, model.id, model.label);
  addOption(launchModel, '__custom', 'Custom model ID…');
  const known = (entry?.models?.values ?? []).some(
    (model) => model.id === saved.model,
  );
  launchModel.value = saved.model ? (known ? saved.model : '__custom') : '';
  launchCustomModel.value = known ? '' : (saved.model ?? '');
  launchCustomModelRow.hidden = launchModel.value !== '__custom';
  launchModel.disabled = false;
  populateLaunchEfforts(saved.effort);
  launchProviderStatus.textContent = entry
    ? entry.installed
      ? `${entry.version ?? 'Installed'} · ${entry.models?.status ?? 'unknown'} model catalog · ${authStatusLabel(entry.authentication)}`
      : entry.installation?.status === 'error'
        ? (entry.installation.detail ?? 'CLI installation check failed.')
        : 'CLI not installed. Install it before launching.'
    : 'Capability catalog unavailable. Auto and custom model remain available.';
  launchDialogRun.disabled = entry?.installed === false;
}

launchProvider.addEventListener('change', () =>
  populateLaunchProvider(launchProvider.value),
);
launchModel.addEventListener('change', () => {
  launchCustomModelRow.hidden = launchModel.value !== '__custom';
  populateLaunchEfforts(launchEffort.value);
  if (!launchCustomModelRow.hidden) launchCustomModel.focus();
});
launchCustomModel.addEventListener('input', () =>
  populateLaunchEfforts(launchEffort.value),
);

document.getElementById('addTerminalBtn').onclick = async () => {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  if (terminalStatusPending || launchDialogPending || commandRunning) return;
  launchDialogPending = true;
  document.getElementById('addTerminalBtn').disabled = true;
  workspaceCreateOperationId = window.crypto.randomUUID();
  launchDialogModal.hidden = false;
  launchDialogModal.setAttribute('aria-busy', 'true');
  launchProviderStatus.classList.add('loading-status');
  launchProviderStatus.textContent =
    'Discovering provider models and checking workspaces…';
  launchProvider.disabled = true;
  launchModel.disabled = true;
  launchEffort.disabled = true;
  launchDialogRun.disabled = true;
  document.getElementById('launchWorkspaceChoice').disabled = true;
  document.getElementById('launchDialogClose').focus();

  try {
    launchProvider.value = 'claude';
    document.getElementById('launchRole').value = 'implement';
    document.getElementById('launchSlug').value = '';
    document.getElementById('launchRoleRow').hidden = true;
    document.getElementById('launchSlugRow').hidden = true;

    const requestedProject = project;
    const [workspaces, catalogResult] = await Promise.all([
      window.relay.workspaceList({ project: requestedProject }),
      loadAgentCatalog().then(
        (agents) => ({ agents, error: null }),
        (error) => ({
          agents: [],
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ]);
    if (project !== requestedProject) return;
    if (!workspaces.ok) {
      launchProviderStatus.textContent = workspaces.output;
      return;
    }
    launchCatalog = catalogResult.agents;
    populateLaunchProvider(launchProvider.value);
    if (catalogResult.error)
      launchProviderStatus.textContent = `${catalogResult.error} Auto and custom model remain available.`;
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
    choice.disabled = false;
    launchProvider.disabled = false;
    launchProvider.focus();
  } catch (error) {
    launchProviderStatus.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    launchDialogModal.setAttribute('aria-busy', 'false');
    launchProviderStatus.classList.remove('loading-status');
    launchDialogPending = false;
    document.getElementById('addTerminalBtn').disabled = false;
  }
};
function closeLaunchDialog() {
  launchDialogModal.hidden = true;
  document.getElementById('addTerminalBtn').focus();
}
document.getElementById('launchDialogClose').onclick = closeLaunchDialog;
document.getElementById('launchWorkspaceChoice').onchange = (e) => {
  const val = e.target.value;
  document.getElementById('launchRoleRow').hidden = val !== '__create';
  document.getElementById('launchSlugRow').hidden = val !== '__create';
};
launchDialogRun.onclick = async () => {
  if (launchDialogPending || commandRunning) return;
  launchDialogPending = true;
  launchDialogRun.disabled = true;
  const provider = document.getElementById('launchProvider').value;
  const model = selectedLaunchModel();
  const effort = launchEffort.value || undefined;
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

    const launched = await launchInteractive('run', provider, {
      workspace,
      model,
      effort,
    });
    if (launched) launchDialogModal.hidden = true;
  } finally {
    launchDialogPending = false;
    const entry = launchCatalog.find(
      (item) => item.id === launchProvider.value,
    );
    launchDialogRun.disabled = entry?.installed === false;
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

  projectButton.disabled =
    locked || projectInitializing || projectChoicePending;
  for (const button of commandButtons)
    button.disabled = locked || !project || projectInitializing;
  for (const button of interactiveButtons)
    button.disabled =
      locked || !project || projectInitializing || terminalStatusPending;
  for (const button of profileButtons)
    button.disabled = locked || !project || projectInitializing;
  document.getElementById('addTerminalBtn').disabled =
    commandRunning || !project || projectInitializing || terminalStatusPending;
  openShellButton.disabled =
    commandRunning ||
    !project ||
    projectInitializing ||
    terminalStatusPending ||
    counts.running >= 4;
  const active = tabsModel.getActive();
  stopButton.disabled =
    !active ||
    !['starting', 'running', 'waiting'].includes(active.metadata.status);
  stopAllButton.disabled = counts.running === 0;
  if (locked) {
    recoverRun.hidden = true;
    resumeRecovered.hidden = true;
  } else {
    recoverRun.hidden = !window.hasRecoverableRun;
    resumeRecovered.hidden = !window.recoveredRun;
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

// The 3a top bar repeats branch and dirtiness beside the project name; the
// metrics strip keeps the authoritative pair.
const topbarGit = document.querySelector('#topbarGit');

function setTopbarGit(branch, changes) {
  if (!topbarGit) return;
  topbarGit.textContent =
    branch && changes ? `${branch} · ${changes.toLowerCase()}` : '—';
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
  setTopbarGit(data.git.currentBranch, dashboardChanges.textContent);
  dashboardCheckpoint.textContent = data.latestCheckpoint
    ? relTime(data.latestCheckpoint.createdAt)
    : 'None';
  checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
  dashboardCheckpoint.disabled = checkpoints.length === 0;
  dashboardCheckpoint.title = checkpoints.length
    ? `View ${checkpoints.length} retained checkpoint${checkpoints.length === 1 ? '' : 's'}`
    : 'No retained checkpoints';
  const reconciliation = Array.isArray(data.reconciliation)
    ? data.reconciliation
    : [];
  window.recoveryRuns = reconciliation.filter(
    (run) => run.status === 'orphaned' || run.status === 'needs_attention',
  );
  window.hasRecoverableRun = window.recoveryRuns.length > 0;
  if (window.recoveryRuns.some((run) => run.status === 'orphaned'))
    recoverRun.textContent = 'Release worktree';
  else if (window.recoveryRuns.length > 0)
    recoverRun.textContent = 'Check session';
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
  renderAttentionCenter();
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
  setTopbarGit(null, null);
  dashboardCheckpoint.textContent = '—';
  dashboardCheckpoint.disabled = true;
  checkpoints = [];
  recoverRun.hidden = true;
  dashboardTest.textContent = '—';
  renderDashboardList(dashboardRemaining, [], message);
  renderDashboardList(dashboardDecisions, [], 'No decisions recorded');
  renderDashboardList(dashboardBlockers, [], 'No blockers');
  agentHistory = [];
  threadTimeline = [];
  timelineCount.textContent = '0';
  if (!timelineModal.hidden) renderTimeline(agentHistory);
  renderAttentionCenter();
  syncControls();
}

async function refreshDashboard() {
  if (!project) {
    renderDashboardUnavailable('Choose a project to begin');
    return;
  }
  dashboard.classList.add('loading');
  try {
    const [result, activity] = await Promise.all([
      window.relay.dashboard({ project }),
      window.relay.activity({ project }),
    ]);
    activitySessions = activity.ok
      ? (activity.data?.sessions ?? []).filter(
          (session) => session.needsAttention,
        )
      : [];
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
  if (active.metadata?.readOnly) return;
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

function closeOnboarding() {
  onboardingModal.hidden = true;
  localStorage.setItem('rirei-onboarding-dismissed', '1');
  projectButton.focus();
}

function openOnboarding() {
  onboardingModal.hidden = false;
  onboardingError.hidden = true;
  onboardingChoose.focus();
}

function readinessCell(key, state) {
  const cell = el('div', 'readiness-cell');
  cell.append(
    el('span', 'readiness-key', key),
    el('strong', `readiness-badge ${state.tone}`, state.label),
    el('small', null, state.detail ?? ''),
  );
  return cell;
}

function renderProviderReadiness(items) {
  onboardingProviders.textContent = '';
  for (const item of items) {
    const row = el('article', 'readiness-row');
    const provider = el('div', 'readiness-provider');
    provider.append(
      el('strong', null, item.displayName),
      el('small', null, item.version ?? 'Version unavailable'),
    );
    row.append(
      provider,
      readinessCell('CLI', {
        ...item.cli,
        detail:
          item.cli.tone === 'ready'
            ? 'Available on PATH.'
            : (item.cli.detail ?? 'Install it, then retry setup.'),
      }),
      readinessCell('Sign-in', item.authentication),
      readinessCell('Usage', item.usage),
    );
    onboardingProviders.append(row);
  }
}

async function runOnboardingChecks() {
  if (!project) return;
  const requestedProject = project;
  onboardingChecks.setAttribute('aria-busy', 'true');
  onboardingStatus.classList.add('loading-status');
  onboardingStatus.textContent =
    'Discovering provider models, versions, and sign-in status…';
  onboardingProviders.textContent = '';
  onboardingProviderStep.className = 'active';
  onboardingUsageStep.className = '';
  onboardingContinue.hidden = true;

  const [catalogResult, usageResult] = await Promise.allSettled([
    loadAgentCatalog(),
    window.relay.usage({ project: requestedProject }),
  ]);
  if (project !== requestedProject) return;

  const catalog =
    catalogResult.status === 'fulfilled' ? catalogResult.value : [];
  const catalogFailed = catalogResult.status === 'rejected';
  const usageFailed =
    usageResult.status === 'rejected' || !usageResult.value?.ok;
  const plans =
    usageResult.status === 'fulfilled' && usageResult.value.ok
      ? usageResult.value.data.plans
      : [];
  const readiness = deriveProviderReadiness(catalog, plans);
  renderProviderReadiness(readiness);

  const setupItems = readiness.filter(
    (item) =>
      item.cli.tone === 'blocked' || item.authentication.tone === 'action',
  ).length;
  const checkWarnings = readiness.filter(
    (item) =>
      item.cli.tone === 'warning' || item.authentication.tone === 'warning',
  ).length;
  onboardingStatus.textContent =
    readiness.length === 0
      ? 'Provider discovery failed. You can continue and retry from a launch dialog.'
      : catalogFailed || usageFailed || checkWarnings > 0
        ? 'Some readiness checks could not be verified. Review the rows below and retry from a launch dialog or Usage.'
        : setupItems > 0
          ? `${setupItems} provider setup item${setupItems === 1 ? '' : 's'} need attention. Unsupported usage sources are informational.`
          : 'Installed providers are ready. Usage limitations are shown below.';
  onboardingStatus.classList.remove('loading-status');
  onboardingChecks.setAttribute('aria-busy', 'false');
  onboardingProviderStep.className = catalogFailed ? 'active' : 'complete';
  onboardingUsageStep.className = usageFailed ? 'active' : 'complete';
  onboardingContinue.hidden = false;
  if (!onboardingModal.hidden) onboardingContinue.focus();
}

async function activateProject(nextProject) {
  project = nextProject;
  currentThreadId = null;
  currentThreadReplyToId = null;
  authoritativeUnread = 0;
  messageDeliveryCatalog = [];
  updateAuthoritativeUnread([]);
  threadsRequestGate.invalidate();
  threadRequestGate.invalidate();
  agentCatalogCache = null;
  localStorage.setItem('relay-project', project);
  window.relay.setActiveProject(project);
  syncControls();
  showProject();
  showOutput();
  output.textContent =
    'Project selected. Initialize or start a task to continue.';
  await Promise.all([refreshDashboard(), loadThreads()]);
}

async function chooseProject({ onboarding = false } = {}) {
  if (projectChoicePending) return null;
  projectChoicePending = true;
  onboardingChoose.disabled = true;
  syncControls();
  try {
    const selected = await window.relay.selectProject();
    if (!selected) return null;
    if (!selected.ok) {
      if (onboarding) {
        onboardingError.textContent = selected.output;
        onboardingError.hidden = false;
      } else {
        show(selected);
      }
      return null;
    }
    onboardingError.hidden = true;
    await activateProject(selected.project);
    if (onboarding) {
      onboardingProjectName.textContent =
        selected.project.split('/').filter(Boolean).at(-1) ?? selected.project;
      onboardingProjectPath.textContent = selected.project;
      onboardingChoose.textContent = 'Choose another';
      onboardingProjectStep.className = 'complete';
      await runOnboardingChecks();
    }
    return selected.project;
  } finally {
    projectChoicePending = false;
    onboardingChoose.disabled = false;
    syncControls();
    if (onboarding && !onboardingError.hidden) onboardingChoose.focus();
  }
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
    return result;
  } finally {
    commandRunning = false;
    syncControls();
  }
}

document.querySelector('#choose').addEventListener('click', async () => {
  if (tabsModel.counts().running > 0 || commandRunning) return;
  await chooseProject();
});
onboardingChoose.addEventListener('click', () =>
  chooseProject({ onboarding: true }),
);
onboardingSkip.addEventListener('click', closeOnboarding);
onboardingContinue.addEventListener('click', closeOnboarding);
document
  .querySelectorAll('[data-command]')
  .forEach((button) =>
    button.addEventListener('click', () => execute(button.dataset.command)),
  );
async function launchInteractive(command, agent, resume = {}) {
  if (command === 'fork-latest') {
    command = 'resume';
    resume = { ...resume, kind: 'latest', fork: true };
  }
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
    const { model, effort } = launchProfileOverrides(
      agentProfiles[agent] ?? {},
      resume,
    );
    showOutput();
    output.textContent = `Discovering ${agent} models and launch capabilities…`;
    const catalog = await loadAgentCatalog().catch(() => []);
    const capabilities = catalog.find((entry) => entry.id === agent);
    const defaultResumeKind =
      capabilities?.resumeCapabilities?.targets?.includes('picker')
        ? 'picker'
        : 'latest';

    const result = await window.relay.interactive({
      project,
      command,
      agent,
      model,
      effort,
      resumeTargetKind: resume.kind ?? defaultResumeKind,
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
  const result = await window.relay.stopTerminal(active.id);
  if (!result?.ok) show(result);
});
stopAllButton.addEventListener('click', async () => {
  const count = tabsModel.counts().running;
  if (count === 0) return;
  if (
    !window.confirm(
      `Stop all ${count} active terminal session${count === 1 ? '' : 's'} on this device?`,
    )
  )
    return;
  stopAllButton.disabled = true;
  const result = await window.relay.stopAllTerminals();
  if (!result?.ok) show(result);
  syncControls();
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
  const orphaned = (window.recoveryRuns ?? []).filter(
    (run) => run.status === 'orphaned',
  );
  if (orphaned.length === 1) {
    const target = orphaned[0];
    const result = await execute('recover');
    if (result?.ok) {
      window.recoveredRun = target;
      resumeRecovered.hidden = false;
    }
  } else await refreshDashboard();
});
resumeRecovered.addEventListener('click', async () => {
  const target = window.recoveredRun;
  if (!target) return;
  const launched = await launchInteractive('resume', target.agent, {
    kind: target.providerSessionId ? 'id' : 'latest',
    value: target.providerSessionId,
    workspace: target.workspaceId,
  });
  if (launched) {
    window.recoveredRun = null;
    resumeRecovered.hidden = true;
  }
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
  return formatElapsedSeconds((end - start) / 1000);
}

function formatElapsedSeconds(value) {
  const seconds = Math.max(0, Math.floor(value));
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
    opencode: 'OpenCode',
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
  if (!run.endedAt && run.lifecycleStatus === 'orphaned') return 'failed';
  if (!run.endedAt) return 'active';
  if (run.exitReason === 'completed') return 'completed';
  if (run.exitReason === 'user_cancelled' || run.exitReason === 'interrupted')
    return 'cancelled';
  return 'failed';
}

function exitDetail(run) {
  const parts = [displayExitReason(run.exitReason)];
  if (run.exitCode != null) parts.push(`code ${run.exitCode}`);
  if (run.exitClassification) {
    const { reason, confidence, source, providerCode } = run.exitClassification;
    const lineage = `${confidence} confidence · ${source.replaceAll('_', ' ')}`;
    if (
      providerCode &&
      providerCode !== String(run.exitCode) &&
      providerCode !== run.exitReason
    )
      return `${parts.join(' · ')} · ${lineage} · provider ${providerCode}`;
    if (reason !== run.exitReason)
      return `${parts.join(' · ')} · ${lineage} (classified as ${displayExitReason(reason)})`;
    return `${parts.join(' · ')} · ${lineage}`;
  }
  return parts.join(' · ');
}

function renderTimeline(runs) {
  timelineList.textContent = '';
  const eventCount = runs.length + threadTimeline.length;
  timelineSummary.textContent =
    eventCount === 0
      ? 'No sessions or coordination threads recorded for this task.'
      : `${eventCount} timeline ${eventCount === 1 ? 'event' : 'events'} · newest first`;

  for (const run of [...runs].reverse()) {
    const tone = timelineTone(run);
    const orphaned = !run.endedAt && run.lifecycleStatus === 'orphaned';
    const item = el('li', `timeline-item ${tone}`);
    item.dataset.at = run.endedAt || run.startedAt;
    const marker = el('span', 'timeline-marker');
    marker.setAttribute('aria-hidden', 'true');
    const card = el('article', 'timeline-card');
    const head = el('div', 'timeline-card-head');
    const identity = el('div', 'timeline-identity');
    const sessionLabel = run.displayLabel || displayAgent(run.agent);
    const labelStrong = el('strong', null, sessionLabel);
    const renameBtn = el('button', 'link-button small', 'Rename');
    renameBtn.title = 'Edit session label';
    renameBtn.addEventListener('click', async () => {
      const newLabel = window.prompt(
        'Enter new session label:',
        run.displayLabel || sessionLabel,
      );
      if (newLabel && newLabel.trim() && newLabel.trim() !== run.displayLabel) {
        const res = await window.relay.renameSession({
          project,
          runId: `run:${run.id}`,
          label: newLabel.trim(),
        });
        if (res.ok) {
          await refreshDashboard();
          openTimeline();
        } else {
          show(res);
        }
      }
    });
    identity.append(
      labelStrong,
      renameBtn,
      el('span', 'timeline-relative', relTime(run.startedAt)),
    );
    const status = el(
      'span',
      'timeline-status',
      orphaned
        ? 'Needs recovery'
        : tone === 'active'
          ? 'Running'
          : displayExitReason(run.exitReason),
    );
    head.append(identity, status);

    const profile = el('div', 'timeline-profile');
    const delivery = messageDeliveryCatalog.find(
      (entry) => entry.id === run.agent,
    )?.capabilities?.messageDelivery;
    const deliveryModes = [
      'Inbox',
      ...(delivery?.nextSafeTurn ? ['Safe turn'] : []),
      ...(delivery?.wake ? ['Wake'] : []),
    ].join(' + ');
    profile.append(
      el('span', null, `Model · ${run.model ?? 'Auto'}`),
      el('span', null, `Effort · ${run.effort ?? 'Auto'}`),
      el('span', null, `Branch · ${run.branchLabel ?? 'main'}`),
      el('span', null, `Delivery · ${deliveryModes}`),
    );

    const facts = el('dl', 'timeline-facts');
    for (const [label, value] of [
      ['Started', formatSessionTime(run.startedAt)],
      [
        'Ended',
        run.endedAt
          ? formatSessionTime(run.endedAt)
          : orphaned
            ? 'Awaiting recovery'
            : 'Still running',
      ],
      [
        'Duration',
        orphaned && Number.isFinite(run.activeRuntimeSeconds)
          ? formatElapsedSeconds(run.activeRuntimeSeconds)
          : formatDuration(run.startedAt, run.endedAt),
      ],
      [
        'Exit',
        run.endedAt
          ? exitDetail(run)
          : orphaned
            ? 'Ownership uncertain'
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
  for (const summary of threadTimeline) {
    const item = el('li', 'timeline-item message');
    item.dataset.at = summary.updatedAt;
    const marker = el('span', 'timeline-marker');
    marker.setAttribute('aria-hidden', 'true');
    const card = el('article', 'timeline-card');
    const participants = (summary.participants || [])
      .map((actor) =>
        actor.kind === 'operator' ? 'Operator' : `run:${actor.runId}`,
      )
      .join(' ↔ ');
    card.append(
      el('strong', null, `Coordination thread ${summary.threadId.slice(0, 8)}`),
      el(
        'div',
        'timeline-relative',
        `${participants} · ${summary.messageCount} messages · ${summary.deliveryState} · ${relTime(summary.updatedAt)}`,
      ),
    );
    item.append(marker, card);
    timelineList.append(item);
  }
  for (const item of [...timelineList.children].sort(
    (left, right) => Date.parse(right.dataset.at) - Date.parse(left.dataset.at),
  ))
    timelineList.append(item);
}

async function openTimeline() {
  renderTimeline(agentHistory);
  timelineModal.hidden = false;
  timelineClose.focus();
  try {
    const requestedProject = project;
    const catalog = await loadAgentCatalog();
    if (project !== requestedProject || timelineModal.hidden) return;
    messageDeliveryCatalog = catalog;
    renderTimeline(agentHistory);
  } catch {
    // Durable session metadata remains available if capability discovery fails.
  }
}

function closeTimeline() {
  timelineModal.hidden = true;
  timelineOpen.focus();
}

timelineOpen.addEventListener('click', openTimeline);
timelineClose.addEventListener('click', closeTimeline);
timelineModal.addEventListener('click', (event) => {
  if (event.target === timelineModal) closeTimeline();
});

/* ---- archived task history ---- */
async function renderHistory(entries) {
  const catalog = await loadAgentCatalog();
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
      const capabilities = catalog.find((entry) => entry.id === run.provider);
      if (
        run.providerSessionId &&
        capabilities?.resumeCapabilities?.targets?.includes('id')
      ) {
        const resume = el('button', null, 'Resume');
        resume.addEventListener('click', () => {
          closeHistory();
          launchInteractive('resume', run.provider, {
            kind: 'id',
            value: run.providerSessionId,
          });
        });
        runRow.append(resume);
        if (capabilities.resumeCapabilities.supportsFork) {
          const fork = el('button', null, 'Fork');
          fork.addEventListener('click', () => {
            closeHistory();
            launchInteractive('resume', run.provider, {
              kind: 'id',
              value: run.providerSessionId,
              fork: true,
              workspace: run.workspaceId,
            });
          });
          runRow.append(fork);
        }
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
  await renderHistory(Array.isArray(result.data) ? result.data : []);
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

/* ---- coordination threads ---- */
async function loadThreads() {
  if (!project) return;
  const requestedProject = project;
  const filter = threadsFilter?.value.trim() || '';
  const ticket = threadsRequestGate.issue(`${requestedProject}\0${filter}`);
  const visibleRequest = window.relay.threads({
    project: requestedProject,
    ...(filter ? { filter } : {}),
  });
  const authoritativeRequest = filter
    ? window.relay.threads({ project: requestedProject })
    : visibleRequest;
  const [visible, authoritative] = await Promise.all([
    visibleRequest,
    authoritativeRequest,
  ]);
  if (
    !threadsRequestGate.accepts(
      ticket,
      `${project}\0${threadsFilter?.value.trim() || ''}`,
    )
  )
    return;
  if (authoritative.ok && Array.isArray(authoritative.data?.summaries)) {
    threadTimeline = authoritative.data.summaries;
    updateAuthoritativeUnread(authoritative.data.summaries);
    if (!timelineModal.hidden) renderTimeline(agentHistory);
  }
  if (visible.ok && Array.isArray(visible.data?.summaries))
    renderThreadsList(visible.data.summaries);
}

function updateAuthoritativeUnread(summaries) {
  authoritativeUnread = summaries.reduce(
    (total, summary) => total + (Number(summary.unreadCount) || 0),
    0,
  );
  threadsBadge.textContent = String(authoritativeUnread);
  threadsBadge.hidden = authoritativeUnread === 0;
  threadsOpen.setAttribute(
    'aria-label',
    authoritativeUnread > 0
      ? `Open coordination threads, ${authoritativeUnread} unread`
      : 'Open coordination threads',
  );
  renderAttentionCenter();
}

function renderAttentionCenter() {
  if (!attentionList) return;
  attentionList.textContent = '';
  if (authoritativeUnread > 0)
    attentionList.append(
      el(
        'li',
        'attention-item unread',
        `${authoritativeUnread} unread coordination ${authoritativeUnread === 1 ? 'message' : 'messages'}`,
      ),
    );
  for (const run of agentHistory.filter(
    (entry) =>
      !entry.endedAt &&
      (['needs_permission', 'waiting_for_input'].includes(
        entry.lifecycleStatus,
      ) ||
        ['permission', 'input'].includes(entry.attentionKind)),
  )) {
    const reason =
      run.attentionKind === 'permission' ||
      run.lifecycleStatus === 'needs_permission'
        ? 'needs permission'
        : 'is waiting for input';
    attentionList.append(
      el(
        'li',
        'attention-item session',
        `${run.displayLabel || displayAgent(run.agent)} ${reason}`,
      ),
    );
  }
  const currentRunIds = new Set(agentHistory.map((run) => run.id));
  for (const session of activitySessions.filter(
    (entry) => !currentRunIds.has(entry.runId),
  )) {
    attentionList.append(
      el(
        'li',
        'attention-item session',
        `${session.projectLabel}: ${displayAgent(session.agent)} ${session.message || 'needs attention'}`,
      ),
    );
  }
  if (attentionList.children.length === 0)
    attentionList.append(
      el('li', 'attention-item quiet', 'No items need attention.'),
    );
}

function renderThreadsList(summaries) {
  if (!threadsList) return;
  threadsList.textContent = '';

  for (const s of summaries) {
    const li = el('li', 'threads-list-item');
    const button = el('button', 'threads-list-button');
    button.type = 'button';
    button.dataset.threadId = s.threadId;
    button.setAttribute(
      'aria-label',
      `Open thread ${s.threadId}, ${s.unreadCount || 0} unread`,
    );
    if (currentThreadId === s.threadId) {
      button.classList.add('selected');
      button.setAttribute('aria-current', 'true');
    }

    const head = el('div', 'threads-list-item-head');
    head.append(
      el('span', 'threads-list-item-title', `thread:${s.threadId.slice(0, 8)}`),
      s.unreadCount > 0
        ? el('span', 'threads-list-item-unread', `${s.unreadCount} unread`)
        : '',
    );

    const snippet = el(
      'div',
      'threads-list-item-snippet',
      s.latestExcerpt || 'No messages',
    );
    button.append(head, snippet);
    li.append(button);

    button.addEventListener('click', () => openThread(s.threadId));
    threadsList.append(li);
  }
}

function receipt(label, timestamp, tone) {
  const item = el(
    'span',
    `thread-receipt ${tone || ''}`,
    `${label}${timestamp ? ` · ${relTime(timestamp)}` : ''}`,
  );
  if (timestamp) item.title = formatExactTimestamp(timestamp);
  return item;
}

function renderMessageReceipts(message) {
  const row = el('div', 'thread-message-receipts');
  const delivery = message.delivery ?? {};
  const deliveryReceipt = {
    queued: ['Queued', message.createdAt, 'queued'],
    delivered: ['Delivered', delivery.deliveredAt, 'delivered'],
    acknowledged: ['Acknowledged', delivery.acknowledgedAt, 'acknowledged'],
    expired: [
      `Expired${delivery.expirationReason ? ` · ${delivery.expirationReason.replaceAll('_', ' ')}` : ''}`,
      delivery.expiredAt,
      'expired',
    ],
  }[delivery.state] ?? ['Unknown delivery', null, 'queued'];
  row.append(receipt(...deliveryReceipt));
  if (delivery.readAt) row.append(receipt('Read', delivery.readAt, 'read'));
  if (delivery.acknowledgedAt && delivery.state !== 'acknowledged')
    row.append(
      receipt('Acknowledged', delivery.acknowledgedAt, 'acknowledged'),
    );
  row.append(receipt(message.deliveryMode || 'inbox', null, 'mode'));
  return row;
}

function renderThreadMessages(threadId, messages) {
  currentThreadReplyToId = messages.at(-1)?.id ?? null;
  replyOperationId = window.crypto.randomUUID();
  threadHeader.textContent = '';
  threadHeader.append(
    el('strong', null, `thread:${threadId}`),
    document.createTextNode(` · ${messages.length} message(s)`),
  );
  threadMessagesList.textContent = '';
  for (const msg of messages) {
    const isOp = msg.from?.kind === 'operator';
    const bubble = el(
      'article',
      `thread-message-bubble ${isOp ? 'from-operator' : ''}`,
    );
    const meta = el('div', 'thread-message-meta');
    const sender = isOp ? 'Operator' : `run:${msg.from?.runId || 'unknown'}`;
    meta.append(
      el('span', null, `${sender} · ${msg.intent}`),
      el('time', null, formatExactTimestamp(msg.createdAt)),
    );
    meta.lastElementChild.dateTime = msg.createdAt;

    bubble.append(meta, el('div', 'thread-message-body', msg.body));

    for (const card of Array.isArray(msg.contextCards)
      ? msg.contextCards
      : []) {
      const cardEl = el('aside', 'thread-card-attachment');
      cardEl.append(
        el('strong', null, card.title),
        el(
          'span',
          'thread-card-meta',
          `${card.kind === 'checkpoint_summary' ? 'Checkpoint' : 'Note'} · ${formatExactTimestamp(card.capturedAt)}`,
        ),
        el('div', 'thread-card-body', card.text),
      );
      bubble.append(cardEl);
    }

    bubble.append(renderMessageReceipts(msg));
    if (
      msg.delivery?.state !== 'acknowledged' &&
      msg.delivery?.state !== 'expired' &&
      msg.to?.kind === 'operator'
    ) {
      const ackBtn = el('button', 'secondary small', 'Acknowledge');
      ackBtn.type = 'button';
      ackBtn.addEventListener('click', async () => {
        ackBtn.disabled = true;
        const result = await window.relay.acknowledgeMessage({
          project,
          messageId: msg.id,
        });
        if (!result.ok) show(result);
        else await openThread(threadId);
      });
      bubble.append(ackBtn);
    }

    threadMessagesList.append(bubble);
  }
  threadMessagesList.scrollTop = threadMessagesList.scrollHeight;
}

async function openThread(threadId) {
  if (!project || !threadId) return;
  const requestedProject = project;
  const ticket = threadRequestGate.issue(`${requestedProject}\0${threadId}`);
  currentThreadId = threadId;
  currentThreadReplyToId = null;
  if (threadComposerContainer) threadComposerContainer.hidden = true;
  if (threadEmptyState) threadEmptyState.hidden = true;
  if (threadMessagesContainer) threadMessagesContainer.hidden = false;

  for (const button of threadsList?.querySelectorAll('.threads-list-button') ??
    []) {
    const selected = button.dataset.threadId === threadId;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }

  threadHeader.textContent = 'Loading thread…';
  const result = await window.relay.thread({
    project: requestedProject,
    threadId,
  });
  if (
    !threadRequestGate.accepts(ticket, `${project}\0${currentThreadId}`) ||
    threadsModal.hidden
  )
    return;
  if (!result.ok || !result.data?.messages) {
    if (threadHeader) threadHeader.textContent = 'Could not load thread.';
    return;
  }

  let messages = result.data.messages;
  const unread = messages.filter(
    (msg) => msg.to?.kind === 'operator' && !msg.delivery?.readAt,
  );
  if (unread.length > 0) {
    const marked = await Promise.all(
      unread.map((msg) =>
        window.relay.markMessageRead({
          project: requestedProject,
          messageId: msg.id,
        }),
      ),
    );
    if (!threadRequestGate.accepts(ticket, `${project}\0${currentThreadId}`))
      return;
    const replacements = new Map(
      marked
        .filter((entry) => entry.ok && entry.data?.message)
        .map((entry) => [entry.data.message.id, entry.data.message]),
    );
    messages = messages.map((msg) => replacements.get(msg.id) ?? msg);
  }
  renderThreadMessages(threadId, messages);
  if (unread.length > 0) await loadThreads();
}

function updateComposerDeliveryOptions() {
  const agent = composerTo?.selectedOptions[0]?.dataset.agent;
  const delivery = messageDeliveryCatalog.find((entry) => entry.id === agent)
    ?.capabilities?.messageDelivery;
  composerDelivery.textContent = '';
  addOption(composerDelivery, 'inbox', 'Inbox (pull-based, standard)');
  if (delivery?.nextSafeTurn)
    addOption(
      composerDelivery,
      'next_safe_turn',
      'Next safe turn (provider-supported)',
    );
  if (delivery?.wake)
    addOption(composerDelivery, 'wake', 'Wake (provider-supported)');
  const modes = [
    'inbox',
    ...(delivery?.nextSafeTurn ? ['next safe turn'] : []),
    ...(delivery?.wake ? ['wake'] : []),
  ];
  composerDeliveryHint.textContent = agent
    ? `This agent advertises ${modes.join(', ')} delivery.`
    : 'Select an active agent to see its delivery capabilities.';
}

async function showNewMessageComposer() {
  if (threadMessagesContainer) threadMessagesContainer.hidden = true;
  if (threadEmptyState) threadEmptyState.hidden = true;
  if (threadComposerContainer) threadComposerContainer.hidden = false;
  if (composerBody) composerBody.value = '';
  if (composerTokenEstimate) composerTokenEstimate.textContent = '~0 tokens';
  sendOperationId = window.crypto.randomUUID();

  if (composerTo) {
    composerTo.textContent = '';
    if (Array.isArray(agentHistory)) {
      const activeRuns = agentHistory.filter(
        (run) =>
          !run.endedAt && typeof run.id === 'string' && run.id.length > 0,
      );
      for (const run of activeRuns) {
        const opt = el(
          'option',
          null,
          `${run.displayLabel || run.agent} (run:${run.id})`,
        );
        opt.value = `run:${run.id}`;
        opt.dataset.agent = run.agent;
        composerTo.append(opt);
      }
    }
  }
  updateComposerDeliveryOptions();
  const requestedProject = project;
  try {
    const catalog = await loadAgentCatalog();
    if (project !== requestedProject || threadComposerContainer.hidden) return;
    messageDeliveryCatalog = catalog;
    updateComposerDeliveryOptions();
  } catch {
    updateComposerDeliveryOptions();
  }
  composerBody?.focus();
}

function openThreads() {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  if (threadsModal) threadsModal.hidden = false;
  threadsClose.focus();
  void loadThreads();
}

function closeThreads() {
  if (threadsModal) threadsModal.hidden = true;
  currentThreadId = null;
  currentThreadReplyToId = null;
  threadsRequestGate.invalidate();
  threadRequestGate.invalidate();
  threadsOpen.focus();
}

if (threadsOpen) threadsOpen.addEventListener('click', openThreads);
if (threadsClose) threadsClose.addEventListener('click', closeThreads);
if (threadsModal) {
  threadsModal.addEventListener('click', (event) => {
    if (event.target === threadsModal) closeThreads();
  });
}
if (threadsNewBtn)
  threadsNewBtn.addEventListener('click', showNewMessageComposer);
if (composerTo)
  composerTo.addEventListener('change', updateComposerDeliveryOptions);
if (composerCancel) {
  composerCancel.addEventListener('click', () => {
    if (threadComposerContainer) threadComposerContainer.hidden = true;
    if (currentThreadId && threadMessagesContainer)
      threadMessagesContainer.hidden = false;
    else if (threadEmptyState) threadEmptyState.hidden = false;
    threadsNewBtn.focus();
  });
}
if (threadsFilter) {
  threadsFilter.addEventListener('input', () => {
    if (threadsFilterTimer) clearTimeout(threadsFilterTimer);
    threadsFilterTimer = setTimeout(loadThreads, 160);
  });
}
if (composerBody) {
  composerBody.addEventListener('input', () => {
    sendOperationId = window.crypto.randomUUID();
    const tokens = Math.ceil(composerBody.value.length / 4);
    if (composerTokenEstimate)
      composerTokenEstimate.textContent = `~${tokens} tokens`;
  });
}
if (threadNewForm) {
  threadNewForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (
      sendMessagePending ||
      !project ||
      !composerTo?.value ||
      !composerBody?.value.trim()
    )
      return;
    sendMessagePending = true;
    const submit = threadNewForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const result = await window.relay.sendMessage({
        project,
        to: composerTo.value,
        intent: composerIntent?.value || 'request',
        delivery: composerDelivery?.value || 'inbox',
        text: composerBody.value.trim(),
        redact: composerRedact?.checked ?? true,
        operationId: sendOperationId ?? window.crypto.randomUUID(),
      });
      if (result.ok && result.data?.message?.threadId) {
        sendOperationId = null;
        await loadThreads();
        await openThread(result.data.message.threadId);
      } else {
        show(result);
      }
    } finally {
      sendMessagePending = false;
      submit.disabled = false;
    }
  });
}
if (threadReplyBody)
  threadReplyBody.addEventListener('input', () => {
    replyOperationId = window.crypto.randomUUID();
  });
if (threadReplyForm) {
  threadReplyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (
      replyMessagePending ||
      !project ||
      !currentThreadId ||
      !currentThreadReplyToId ||
      !threadReplyBody?.value.trim()
    )
      return;
    replyMessagePending = true;
    const submit = threadReplyForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    const threadId = currentThreadId;
    try {
      const result = await window.relay.replyMessage({
        project,
        parentMessageId: currentThreadReplyToId,
        text: threadReplyBody.value.trim(),
        redact: threadReplyRedact?.checked ?? true,
        operationId: replyOperationId ?? window.crypto.randomUUID(),
      });
      if (result.ok) {
        replyOperationId = null;
        threadReplyBody.value = '';
        await openThread(threadId);
        await loadThreads();
      } else {
        show(result);
      }
    } finally {
      replyMessagePending = false;
      submit.disabled = false;
    }
  });
}

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
let usageRequest = 0;
let usageCapturedAt = 0;

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
  usageCapturedAt = Math.max(
    usageCapturedAt,
    ...data.plans.map((plan) => Date.parse(plan.capturedAt ?? '') || 0),
  );
  usageTask.textContent = '';
  usageTask.append(
    document.createTextNode(`${data.task.title}  `),
    el('span', null, `· ${data.task.status}`),
  );
  usageGrid.textContent = '';
  usageSummary.textContent = '';
  const reporting = data.plans.filter((plan) =>
    ['available', 'stale'].includes(plan.status),
  );
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
    const status = el('div', 'plan-status', planStatusLabel(plan));
    const windows = el('div', 'agent-windows');
    const windowEntries =
      plan.metrics && plan.metrics.length > 0
        ? plan.metrics.map((metric) => [
            metric.window?.label ?? metric.id,
            metric,
          ])
        : [
            ['5-hour', plan.fiveHour],
            ['Weekly', plan.week],
          ];
    for (const [label, window] of windowEntries) {
      const row = el('div', 'window-row');
      const presentation = usageWindowPresentation(window);
      if (presentation.stale) row.classList.add('stale');
      const track = el('span', 'usage-track');
      const fill = el('span', 'usage-fill');
      const { percent } = presentation;
      fill.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
      if (percent != null && percent < 20) fill.classList.add('critical');
      else if (percent != null && percent < 50) fill.classList.add('warning');
      track.append(fill);
      const exactReset = formatExactTimestamp(window?.resetsAt);
      const reset = el(
        'small',
        null,
        exactReset ? `resets ${exactReset}` : 'reset unknown',
      );
      if (window?.resetsAt) reset.title = window.resetsAt;
      row.append(
        el('span', 'window-label', label),
        track,
        el('strong', null, presentation.valueLabel),
        reset,
      );
      windows.append(row);
    }
    const meta = el('div', 'meta');
    const exactCapture = formatExactTimestamp(plan.capturedAt);
    const capture = el(
      'span',
      null,
      exactCapture
        ? `updated ${exactCapture} (${relTime(plan.capturedAt)})`
        : 'not reported',
    );
    if (plan.capturedAt) capture.title = plan.capturedAt;
    meta.append(
      el('span', null, plan.detail),
      el('span', null, `source: ${plan.source}`),
      capture,
    );
    card.append(name, status, windows, meta);
    usageGrid.append(card);
  }
}

async function openUsage() {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  const requestedProject = project;
  const request = ++usageRequest;
  usageCapturedAt = 0;
  usageModal.hidden = false;
  usageModal.setAttribute('aria-busy', 'true');
  usageTask.textContent = 'Reading verified provider usage sources…';
  usageSummary.textContent = 'Loading usage';
  usageSummary.classList.add('loading-status');
  usageGrid.textContent = '';
  usageClose.focus();
  const res = await window.relay.usage({ project: requestedProject });
  if (request !== usageRequest) return;
  if (project !== requestedProject) return closeUsage();
  usageModal.setAttribute('aria-busy', 'false');
  usageSummary.classList.remove('loading-status');
  if (!res.ok) {
    usageTask.textContent = res.output || 'Could not read usage.';
    usageSummary.textContent = '';
    return;
  }
  const responseCapturedAt = Math.max(
    0,
    ...res.data.plans.map((plan) => Date.parse(plan.capturedAt ?? '') || 0),
  );
  if (responseCapturedAt >= usageCapturedAt) renderUsage(res.data);
}

function closeUsage() {
  usageRequest += 1;
  usageModal.hidden = true;
  usageBtn.focus();
}

usageBtn.addEventListener('click', openUsage);
usageClose.addEventListener('click', closeUsage);
usageModal.addEventListener('click', (event) => {
  if (event.target === usageModal) closeUsage();
});

/* ---- launch and task-record drawer ---- */

const drawer = document.querySelector('.drawer');
const drawerToggle = document.querySelector('#drawerToggle');
const drawerClose = document.querySelector('.drawer-close');
const railPanelItems = [...document.querySelectorAll('.rail-item[data-panel]')];

// The rail's Task/Agents/Notes entries scroll the drawer to their section
// rather than swapping panels: 3a shows launch and record in one column. Two
// entries can share a section, so the active state keys on the item itself.
const drawerSections = {
  launch: '.launch-list',
  record: '.record',
};

function setDrawerOpen(open) {
  if (!drawer) return;
  drawer.hidden = !open;
  drawerToggle?.setAttribute('aria-expanded', String(open));
}

function selectRailPanel(selected) {
  for (const item of railPanelItems) {
    const active = item === selected;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-pressed', String(active));
  }
  setDrawerOpen(true);
  const target = drawer?.querySelector(
    drawerSections[selected.dataset.section] ?? '',
  );
  target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

for (const item of railPanelItems) {
  item.addEventListener('click', () => selectRailPanel(item));
}

drawerToggle?.addEventListener('click', () => setDrawerOpen(drawer.hidden));
drawerClose?.addEventListener('click', () => setDrawerOpen(false));

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
  return selectedModelValue(profileModel.value, profileCustomModel.value);
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
  const efforts = effortsForModel(selectedCatalogAgent, model);
  profileEffort.textContent = '';
  addOption(profileEffort, '', 'Auto · provider default');
  for (const effort of efforts) addOption(profileEffort, effort, effort);
  profileEffort.disabled = efforts.length === 0;
  profileEffort.value = efforts.includes(preferred) ? preferred : '';
  updateProfilePreview();
}

async function loadAgentCatalog() {
  if (
    agentCatalogCache?.project === project &&
    agentCatalogCache.expiresAt > Date.now()
  )
    return agentCatalogCache.agents;
  const requestProject = project;
  const result = await window.relay.agentCatalog({ project: requestProject });
  if (!result.ok)
    throw new Error(result.output || 'Could not load agent catalog.');
  if (project === requestProject)
    agentCatalogCache = {
      project: requestProject,
      agents: result.data.agents,
      expiresAt: Date.now() + 45_000,
    };
  return result.data.agents;
}

function authStatusLabel(auth) {
  if (!auth) return 'Unknown';
  const labels = {
    authenticated: 'Authenticated',
    not_authenticated: 'Sign-in required',
    configured: 'Configured',
    unknown: 'Unknown',
    unsupported: 'Unsupported',
    error: 'Error',
  };
  return labels[auth.status] ?? 'Unknown';
}

async function openProfile(agent) {
  if (!project)
    return show({ ok: false, output: 'Choose a project folder first.' });
  selectedProfileAgent = agent;
  selectedCatalogAgent = null;
  profileModal.hidden = false;
  profileModal.setAttribute('aria-busy', 'true');
  profileTitle.textContent = agent;
  profileStatus.classList.add('loading-status');
  profileStatus.textContent =
    'Discovering models and checking provider sign-in…';
  profileModel.disabled = true;
  profileEffort.disabled = true;
  try {
    const catalog = await loadAgentCatalog();
    selectedCatalogAgent = catalog.find((item) => item.id === agent);
    if (!selectedCatalogAgent)
      throw new Error(`No adapter found for ${agent}.`);
    profileTitle.textContent = selectedCatalogAgent.displayName;
    profileStatus.textContent = selectedCatalogAgent.installed
      ? `${selectedCatalogAgent.version ?? 'Installed'} · ${selectedCatalogAgent.models.status} model catalog · ${authStatusLabel(selectedCatalogAgent.authentication)}`
      : selectedCatalogAgent.installation?.status === 'error'
        ? (selectedCatalogAgent.installation.detail ??
          'CLI installation check failed · selections can be saved for later')
        : 'CLI not installed · selections can be saved for later';
    if (selectedCatalogAgent.authentication?.detail) {
      profileStatus.title = selectedCatalogAgent.authentication.detail;
    }
    const saved = agentProfiles[agent] ?? {};
    profileModel.textContent = '';
    addOption(profileModel, '', 'Auto · provider default');
    for (const model of selectedCatalogAgent.models?.values ?? [])
      addOption(profileModel, model.id, model.label);
    addOption(profileModel, '__custom', 'Custom model ID…');
    const known = (selectedCatalogAgent.models?.values ?? []).some(
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
  } finally {
    profileModal.setAttribute('aria-busy', 'false');
    profileStatus.classList.remove('loading-status');
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
  const modal = Array.from(document.querySelectorAll('.modal'))
    .filter((candidate) => !candidate.hidden)
    .at(-1);
  if (event.key === 'Escape' && modal) {
    const closeModal = {
      closeTabModal: () => document.getElementById('closeTabCancel').click(),
      onboardingModal: closeOnboarding,
      launchDialogModal: closeLaunchDialog,
      timelineModal: closeTimeline,
      usageModal: closeUsage,
      historyModal: closeHistory,
      checkpointModal: closeCheckpointViewer,
      profileModal: closeProfile,
      threadsModal: closeThreads,
    }[modal.id];
    closeModal?.();
    event.preventDefault();
    return;
  }
  if (event.key === 'Tab' && modal) {
    const focusable = Array.from(
      modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
const removeTerminalControlListener = window.relay.onTerminalControl?.(
  (event) => {
    const readOnly = event.readOnly !== false;
    tabsModel.updateMetadata(event.terminalId, { readOnly });
    const tab = tabsModel.get(event.terminalId);
    if (tab?.terminal) {
      tab.terminal.options.disableStdin = readOnly;
    }
    renderTabs();
    syncControls();
  },
);
const removeUsageUpdateListener = window.relay.onUsageUpdate((data) => {
  if (!usageModal.hidden) {
    const incomingCapturedAt = Math.max(
      0,
      ...data.plans.map((plan) => Date.parse(plan.capturedAt ?? '') || 0),
    );
    if (incomingCapturedAt >= usageCapturedAt) {
      usageModal.setAttribute('aria-busy', 'false');
      usageSummary.classList.remove('loading-status');
      renderUsage(data);
    }
  }
});
const removeDeepLinkListener = window.relay.onDeepLink(receiveDeepLink);
const removeThreadsListener = window.relay.onThreadsChanged?.((event) => {
  if (!project || event?.projectRoot !== project) return;
  void loadThreads();
  if (!threadsModal.hidden && currentThreadId) void openThread(currentThreadId);
});

updateProfileButtons();

async function initializeProject() {
  let invalidRememberedProject = false;
  showProject();
  syncControls();
  if (project) {
    const validation = await window.relay
      .validateProject({ project })
      .catch(() => ({ ok: false }));
    if (validation.ok) {
      project = validation.project;
      localStorage.setItem('relay-project', project);
    } else {
      project = '';
      invalidRememberedProject = true;
      localStorage.removeItem('relay-project');
    }
  }
  projectInitializing = false;
  if (!project) output.textContent = HOW_TO;
  window.relay.setActiveProject(project || null);
  showProject();
  syncControls();
  await refreshDashboard().catch(() =>
    renderDashboardUnavailable('Could not read project status'),
  );
  if (project) await loadThreads().catch(() => undefined);
  if (
    !project &&
    (invalidRememberedProject ||
      localStorage.getItem('rirei-onboarding-dismissed') !== '1')
  )
    openOnboarding();
}

void initializeProject();

function factory(item) {
  if (tabsModel.get(item.id)) return tabsModel.get(item.id);
  const instances = createXterm(item.id);
  if (!instances) return null;
  instances.terminal.options.disableStdin = item.readOnly === true;
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
  removeTerminalControlListener?.();
  removeUsageUpdateListener?.();
  removeDeepLinkListener?.();
  removeThreadsListener?.();
  deepLinkQueue = [];
  for (const terminal of tabsModel.getAll()) terminal.dispose?.();
});
