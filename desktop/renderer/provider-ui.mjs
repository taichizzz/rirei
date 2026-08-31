export function effortsForModel(entry, model) {
  const modelOption = entry?.models?.values?.find((item) => item.id === model);
  return modelOption?.efforts !== undefined
    ? modelOption.efforts
    : (entry?.efforts ?? []);
}

export function selectedModelValue(selection, customModel) {
  if (selection === '__custom') return customModel.trim() || undefined;
  return selection || undefined;
}

export function launchProfileOverrides(profile, request) {
  return {
    model: Object.hasOwn(request, 'model') ? request.model : profile.model,
    effort: Object.hasOwn(request, 'effort') ? request.effort : profile.effort,
  };
}

export function planStatusLabel(plan) {
  const reasonLabels = {
    not_collected: 'Not collected',
    unsupported_auth: 'Authentication-specific',
    unsupported_provider: 'Unsupported',
    collector_error: 'Read error',
    all_windows_stale: 'Stale',
  };
  const statusLabels = {
    available: 'Live',
    stale: 'Stale',
    unknown: 'Unknown',
    unsupported: 'Unsupported',
    error: 'Error',
  };
  return (
    reasonLabels[plan.statusReason] ?? statusLabels[plan.status] ?? 'Unknown'
  );
}

export function usageWindowPresentation(window) {
  const remaining = window?.remaining ?? window?.remainingPercentage;
  const percent =
    window?.unit === 'percent' || window?.remainingPercentage !== undefined
      ? remaining
      : window?.limit && remaining != null
        ? (remaining / window.limit) * 100
        : null;
  const unit =
    window?.unit === 'percent' || window?.remainingPercentage !== undefined
      ? '%'
      : ` ${window?.unit ?? ''}`;
  return {
    remaining,
    percent,
    stale: window?.status === 'stale',
    valueLabel:
      remaining == null
        ? '—'
        : `${Math.round(remaining)}${unit}${window?.status === 'stale' ? ' stale' : ''}`,
  };
}

export function formatExactTimestamp(iso, { locale, timeZone } = {}) {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(value);
}

function authenticationReadiness(entry) {
  if (!entry.installed)
    return {
      label: 'Unavailable',
      tone: 'blocked',
      detail: 'Install the official CLI before checking sign-in.',
    };
  const status = entry.authentication?.status;
  if (status === 'authenticated')
    return {
      label: 'Signed in',
      tone: 'ready',
      detail: 'Verified by the CLI.',
    };
  if (status === 'configured')
    return {
      label: 'Configured',
      tone: 'neutral',
      detail: 'Credentials are configured; validity is checked on launch.',
    };
  if (status === 'not_authenticated')
    return {
      label: 'Sign-in required',
      tone: 'action',
      detail: 'Run the provider CLI and complete its sign-in flow.',
    };
  if (status === 'error')
    return {
      label: 'Check failed',
      tone: 'warning',
      detail: 'Rirei could not safely verify sign-in.',
    };
  return {
    label: 'Checked on launch',
    tone: 'neutral',
    detail: 'This provider does not expose a verified sign-in check.',
  };
}

function usageReadiness(plan) {
  const states = {
    live_window: {
      label: 'Reporting',
      tone: 'ready',
      detail: 'Verified quota windows are available.',
    },
    all_windows_stale: {
      label: 'Stale',
      tone: 'warning',
      detail: 'Usage exists, but its provider sample is stale.',
    },
    not_collected: {
      label: 'Not collected yet',
      tone: 'neutral',
      detail: 'Launch through Rirei and send a prompt to begin collection.',
    },
    unsupported_auth: {
      label: 'Account-specific',
      tone: 'neutral',
      detail: 'The CLI does not expose a verified account quota source.',
    },
    unsupported_provider: {
      label: 'Unsupported',
      tone: 'neutral',
      detail: 'No verified machine-readable usage source is available.',
    },
    collector_error: {
      label: 'Read failed',
      tone: 'warning',
      detail: 'The provider usage source could not be read safely.',
    },
  };
  return (
    states[plan?.statusReason] ?? {
      label: 'Not checked',
      tone: 'neutral',
      detail: 'Usage reporting has not been checked for this project.',
    }
  );
}

export function deriveProviderReadiness(catalog = [], plans = []) {
  return catalog.map((entry) => {
    const installationError = entry.installation?.status === 'error';
    return {
      id: entry.id,
      displayName: entry.displayName,
      version: entry.version,
      cli: entry.installed
        ? { label: 'Installed', tone: 'ready' }
        : installationError
          ? {
              label: 'Check failed',
              tone: 'warning',
              detail:
                entry.installation.detail ??
                'Rirei could not verify the provider executable.',
            }
          : { label: 'CLI missing', tone: 'blocked' },
      authentication: authenticationReadiness(entry),
      usage: usageReadiness(plans.find((plan) => plan.id === entry.id)),
    };
  });
}
