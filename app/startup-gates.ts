export function createStartupLifecycle() {
  let bootFinished = false;
  let bootTimedOut = false;
  let disposed = false;

  return {
    canContinueBoot() {
      return !disposed && !bootTimedOut && !bootFinished;
    },
    canReceiveAuthEvent() {
      return !disposed && !bootTimedOut;
    },
    finishBoot() {
      bootFinished = true;
    },
    finishPendingBoot() {
      if (!this.canContinueBoot()) return false;
      bootFinished = true;
      return true;
    },
    expireBoot() {
      if (!this.canContinueBoot()) return false;
      bootFinished = true;
      bootTimedOut = true;
      return true;
    },
    dispose() {
      disposed = true;
    },
  };
}

export function isTrustedDashboardReadyMessage(
  event: { origin?: string; source?: MessageEventSource | null; data?: { type?: unknown } },
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
) {
  return event.origin === expectedOrigin && event.source === expectedSource &&
    event.data?.type === "folio-dashboard-app-ready";
}

export function nextDashboardFrameKey(current: number) {
  return current + 1;
}
