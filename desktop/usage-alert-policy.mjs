export const DEFAULT_USAGE_THRESHOLDS = Object.freeze([20, 5]);

const WINDOW_KEYS = Object.freeze(['fiveHour', 'week']);

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentage(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}

export function createUsageAlertPolicy(thresholds = DEFAULT_USAGE_THRESHOLDS) {
  const orderedThresholds = [...thresholds]
    .filter((value) => percentage(value) !== null)
    .sort((left, right) => right - left);
  const states = new Map();
  const providerCaptures = new Map();

  return {
    evaluate(project, snapshot) {
      if (
        typeof project !== 'string' ||
        !project ||
        !snapshot ||
        !Array.isArray(snapshot.plans)
      )
        return [];

      const alerts = [];
      for (const plan of snapshot.plans) {
        if (!plan || typeof plan.id !== 'string' || plan.status !== 'available')
          continue;
        const capturedAt = timestamp(plan.capturedAt);
        if (capturedAt === null) continue;
        const providerKey = `${project}\0${plan.id}`;
        const previousCapture = providerCaptures.get(providerKey);
        if (previousCapture !== undefined && capturedAt <= previousCapture)
          continue;
        providerCaptures.set(providerKey, capturedAt);

        for (const windowKey of WINDOW_KEYS) {
          const usageWindow = plan[windowKey];
          const remaining = percentage(usageWindow?.remainingPercentage);
          if (usageWindow?.status !== 'available' || remaining === null)
            continue;

          const resetAt =
            usageWindow.resetsAt === null
              ? null
              : timestamp(usageWindow.resetsAt);
          if (usageWindow.resetsAt !== null && resetAt === null) continue;

          const key = `${project}\0${plan.id}\0${windowKey}`;
          const previous = states.get(key);
          if (previous && capturedAt <= previous.capturedAt) continue;
          if (
            previous &&
            previous.resetAt !== null &&
            (resetAt === null || resetAt < previous.resetAt)
          )
            continue;

          const resetAdvanced =
            previous &&
            previous.resetAt !== null &&
            resetAt !== null &&
            resetAt > previous.resetAt;
          const seen = resetAdvanced
            ? new Set()
            : new Set(previous?.seen ?? []);
          const newlyCrossed = orderedThresholds.filter(
            (threshold) => remaining <= threshold && !seen.has(threshold),
          );
          for (const threshold of orderedThresholds) {
            if (remaining <= threshold) seen.add(threshold);
          }

          states.set(key, { capturedAt, resetAt, seen });
          if (newlyCrossed.length > 0) {
            alerts.push({
              provider: plan.id,
              window: windowKey,
              threshold: newlyCrossed.at(-1),
            });
          }
        }
      }
      return alerts;
    },
  };
}
