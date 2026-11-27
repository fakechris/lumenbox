/**
 * Three-tier macOS sleep coordination for personal-mode mobile access (docs/109 §3.3, INV-2216).
 *
 * 1. Idle sleep prevention (default, zero privilege): holds `powerSaveBlocker.start("prevent-app-suspension")`
 *    whenever `(mobileAccessEnabled && onAcPower) || activeTurns > 0`, and releases it otherwise.
 * 2. Immediate pre-sleep notice: listens to `powerMonitor.on("suspend")` and fires `onSuspendNotice`
 *    within the pre-sleep window so active relay multiplexers transmit a `host_sleeping` frame
 *    before Darwin freezes sockets.
 * 3. Optional AC-only clamshell awake setting: when the Owner enables `clamshellAwakeOnAc` and the
 *    machine is on AC power, invokes the injected `applyChargerSleepDisabled(true)` (`pmset -c
 *    disablesleep 1`); automatically reverts to `false` the moment battery power is detected
 *    (`on-battery`) or on shutdown so a MacBook in a bag never stays awake on battery.
 *
 * Electron-free by dependency injection so the entire state machine runs under `npm test`.
 */

function createMobileSleepGuard({
  powerSaveBlocker,
  powerMonitor,
  applyChargerSleepDisabled = async () => {},
  onSuspendNotice = () => {},
  initialOnBattery = false,
  now = () => new Date().toISOString(),
  log = () => {},
}) {
  let mobileAccessEnabled = false;
  let activeTurns = 0;
  let onAcPower = typeof powerMonitor?.isOnBatteryPower === "function"
    ? !powerMonitor.isOnBatteryPower()
    : !initialOnBattery;
  let clamshellAwakeOnAc = false;
  let blockerId = null;
  let chargerSleepDisabledApplied = false;
  let disposed = false;

  function syncIdleBlocker() {
    if (disposed) return;
    const shouldHold = (mobileAccessEnabled && onAcPower) || activeTurns > 0;
    if (shouldHold && blockerId === null) {
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
      log(`mobile sleep: holding prevent-app-suspension (${blockerId})`);
    } else if (!shouldHold && blockerId !== null) {
      if (powerSaveBlocker.isStarted(blockerId)) {
        powerSaveBlocker.stop(blockerId);
      }
      log(`mobile sleep: released prevent-app-suspension (${blockerId})`);
      blockerId = null;
    }
  }

  async function syncClamshellSetting() {
    const shouldDisableChargerSleep = !disposed && mobileAccessEnabled && clamshellAwakeOnAc && onAcPower;
    if (shouldDisableChargerSleep === chargerSleepDisabledApplied) return;
    chargerSleepDisabledApplied = shouldDisableChargerSleep;
    try {
      await applyChargerSleepDisabled(shouldDisableChargerSleep);
      log(`mobile sleep: pmset -c disablesleep ${shouldDisableChargerSleep ? "1" : "0"}`);
    } catch (err) {
      chargerSleepDisabledApplied = !shouldDisableChargerSleep;
      log(`mobile sleep: could not update clamshell sleep setting: ${err.message}`);
      throw err;
    }
  }

  const onSuspend = () => {
    if (disposed) return;
    const at = now();
    log(`mobile sleep: system suspending at ${at}; notifying connected mobile clients`);
    onSuspendNotice({ at, reason: "suspend" });
  };

  const onBattery = () => {
    if (disposed) return;
    onAcPower = false;
    syncIdleBlocker();
    void syncClamshellSetting().catch(() => {});
  };

  const onAc = () => {
    if (disposed) return;
    onAcPower = true;
    syncIdleBlocker();
    void syncClamshellSetting().catch(() => {});
  };

  powerMonitor?.on?.("suspend", onSuspend);
  powerMonitor?.on?.("on-battery", onBattery);
  powerMonitor?.on?.("on-ac", onAc);

  return {
    get state() {
      return {
        mobileAccessEnabled,
        activeTurns,
        onAcPower,
        clamshellAwakeOnAc,
        holdingIdleBlocker: blockerId !== null,
        chargerSleepDisabledApplied,
      };
    },
    setMobileAccessEnabled(enabled) {
      mobileAccessEnabled = Boolean(enabled);
      syncIdleBlocker();
      return syncClamshellSetting();
    },
    setActiveTurns(count) {
      activeTurns = Math.max(0, Math.floor(Number(count) || 0));
      syncIdleBlocker();
    },
    setClamshellAwakeOnAc(enabled) {
      clamshellAwakeOnAc = Boolean(enabled);
      return syncClamshellSetting();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      powerMonitor?.removeListener?.("suspend", onSuspend);
      powerMonitor?.removeListener?.("on-battery", onBattery);
      powerMonitor?.removeListener?.("on-ac", onAc);
      if (blockerId !== null) {
        if (powerSaveBlocker.isStarted(blockerId)) {
          powerSaveBlocker.stop(blockerId);
        }
        blockerId = null;
      }
      if (chargerSleepDisabledApplied) {
        chargerSleepDisabledApplied = false;
        await applyChargerSleepDisabled(false).catch(() => {});
      }
    },
  };
}

module.exports = { createMobileSleepGuard };
