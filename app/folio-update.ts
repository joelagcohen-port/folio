type VersionContract = { buildId: string; apiGeneration: number; minSupportedGeneration: number };
type UpdatePhase = "active" | "launch" | "resume";
type UpdateControllerOptions = {
  buildId: string;
  apiGeneration: number;
  fetchVersion: () => Promise<VersionContract | null>;
  updateWorker: (version: VersionContract) => Promise<boolean>;
  canAutoReload: (phase?: UpdatePhase) => boolean;
  reload: (buildId: string) => void;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  setAvailable: (available: boolean) => void;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

export function isFolioReloadSafe(input: { visible: boolean; modalOpen: boolean; dirtyFields: boolean; pendingRequests: number; appReady: boolean; idleMs: number; immediate?: boolean; phaseActivityValid?: boolean }) {
  return input.visible && !input.modalOpen && !input.dirtyFields && input.pendingRequests <= 0 && input.phaseActivityValid !== false && (input.immediate || !input.appReady || input.idleMs >= 30_000);
}

export function didFolioRecoveryLand(clientBuild: string, clientGeneration: number, serverBuild: string, serverGeneration: number, targetPrefix: string) {
  return Boolean(targetPrefix) && clientBuild.startsWith(targetPrefix) && serverBuild === clientBuild && clientGeneration === serverGeneration;
}

export async function confirmFolioWorkerTarget(
  target: VersionContract,
  queryIdentity: () => Promise<Partial<VersionContract> | null>,
  waitForActivation: () => Promise<boolean>,
) {
  const matches = (identity: Partial<VersionContract> | null) => identity?.buildId === target.buildId && Number(identity.apiGeneration) === Number(target.apiGeneration) && Number(identity.minSupportedGeneration) === Number(target.minSupportedGeneration);
  if (matches(await queryIdentity().catch(() => null))) return true;
  if (!await waitForActivation().catch(() => false)) return false;
  return matches(await queryIdentity().catch(() => null));
}

export function createFolioUpdateController(options: UpdateControllerOptions) {
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let checking: Promise<void> | null = null;
  let checkingPhase: UpdatePhase = "active";
  let lastCheck = 0;
  let stopped = false;
  const keyFor = (id: string) => `folio-update-attempt:${id}`;

  async function check(force = false, phase: UpdatePhase = "active") {
    if (stopped) return checking;
    if (pending !== null) return checking;
    if (checking) {
      if (phase === "launch" || (phase === "resume" && checkingPhase === "active")) checkingPhase = phase;
      return checking;
    }
    if (!force && Date.now() - lastCheck < 10_000) return checking;
    lastCheck = Date.now();
    checkingPhase = phase;
    checking = (async () => {
      const version = await options.fetchVersion().catch(() => null);
      if (stopped || !version || !version.buildId) return;
      const available = version.buildId !== options.buildId || options.apiGeneration < version.minSupportedGeneration || options.apiGeneration > version.apiGeneration;
      if (!available) { options.setAvailable(false); try { options.storage.removeItem(keyFor(version.buildId)); } catch {} return; }
      const ready = await options.updateWorker(version).catch(() => false);
      if (stopped) return;
      if (!ready) { options.setAvailable(true); return; }
      const targetPhase = checkingPhase;
      if (!options.canAutoReload(targetPhase)) { options.setAvailable(true); return; }
      let attempted = true;
      try { attempted = options.storage.getItem(keyFor(version.buildId)) === "1"; } catch {}
      if (attempted) { options.setAvailable(true); return; }
      options.setAvailable(false);
      pending = schedule(() => {
        pending = null;
        if (stopped) return;
        if (!options.canAutoReload(targetPhase)) { options.setAvailable(true); return; }
        try {
          options.storage.setItem(keyFor(version.buildId), "1");
          if (options.storage.getItem(keyFor(version.buildId)) !== "1") { options.setAvailable(true); return; }
        } catch { options.setAvailable(true); return; }
        options.reload(version.buildId);
      }, 0);
    })().finally(() => { checking = null; });
    return checking;
  }

  async function updateNow() {
    if (stopped) return false;
    const version = await options.fetchVersion().catch(() => null);
    if (!version?.buildId) return false;
    const available = version.buildId !== options.buildId || options.apiGeneration < version.minSupportedGeneration || options.apiGeneration > version.apiGeneration;
    options.setAvailable(available);
    if (!available) return false;
    const ready = await options.updateWorker(version).catch(() => false);
    if (!ready || stopped) return false;
    try { options.storage.setItem(keyFor(version.buildId), "1"); } catch {}
    options.reload(version.buildId);
    return true;
  }

  function prepareLaunch(buildId: string, recoveryTarget: string | null) {
    // A failed automatic landing keeps its retry budget on that landing. A
    // later cold launch without the recovery URL is a new, safe retry window.
    if (!buildId || recoveryTarget) return false;
    try { options.storage.removeItem(keyFor(buildId)); return true; } catch { return false; }
  }

  function stop() {
    stopped = true;
    pause();
  }
  function pause() {
    if (pending !== null) cancel(pending);
    pending = null;
  }
  return { check, updateNow, prepareLaunch, pause, stop };
}
