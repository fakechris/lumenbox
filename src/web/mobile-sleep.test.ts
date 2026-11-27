import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";

const { createMobileSleepGuard } = createRequire(import.meta.url)(
  "../../electron/mobile-sleep.cjs",
) as {
  createMobileSleepGuard(options: {
    powerSaveBlocker: {
      start(type: string): number;
      stop(id: number): void;
      isStarted(id: number): boolean;
    };
    powerMonitor: EventEmitter & { isOnBatteryPower(): boolean };
    applyChargerSleepDisabled?: (disabled: boolean) => Promise<void>;
    onSuspendNotice?: (info: { at: string; reason: string }) => void;
    now?: () => string;
  }): {
    readonly state: {
      mobileAccessEnabled: boolean;
      activeTurns: number;
      onAcPower: boolean;
      clamshellAwakeOnAc: boolean;
      holdingIdleBlocker: boolean;
      chargerSleepDisabledApplied: boolean;
    };
    setMobileAccessEnabled(enabled: boolean): Promise<void>;
    setActiveTurns(count: number): void;
    setClamshellAwakeOnAc(enabled: boolean): Promise<void>;
    dispose(): Promise<void>;
  };
};

test("Electron mobile sleep guard coordinates idle blocker, pre-sleep suspend notice, and AC-only clamshell awake setting", async () => {
  let nextBlockerId = 1;
  const activeBlockers = new Set<number>();
  const powerSaveBlocker = {
    start(type: string) {
      assert.equal(type, "prevent-app-suspension");
      const id = nextBlockerId++;
      activeBlockers.add(id);
      return id;
    },
    stop(id: number) {
      activeBlockers.delete(id);
    },
    isStarted(id: number) {
      return activeBlockers.has(id);
    },
  };

  let battery = false;
  const powerMonitor = Object.assign(new EventEmitter(), {
    isOnBatteryPower: () => battery,
  });

  const pmsetCalls: boolean[] = [];
  const suspendNotices: Array<{ at: string; reason: string }> = [];

  const guard = createMobileSleepGuard({
    powerSaveBlocker,
    powerMonitor,
    applyChargerSleepDisabled: async (disabled) => {
      pmsetCalls.push(disabled);
    },
    onSuspendNotice: (info) => suspendNotices.push(info),
    now: () => "2026-11-27T09:50:00.000Z",
  });

  assert.equal(guard.state.holdingIdleBlocker, false);

  // 1. Enabling mobile access on AC holds prevent-app-suspension
  await guard.setMobileAccessEnabled(true);
  assert.equal(guard.state.holdingIdleBlocker, true);
  assert.equal(activeBlockers.size, 1);

  // 2. Enabling AC-only clamshell awake applies pmset -c disablesleep 1
  await guard.setClamshellAwakeOnAc(true);
  assert.deepEqual(pmsetCalls, [true]);
  assert.equal(guard.state.chargerSleepDisabledApplied, true);

  // 3. Unplugging charger (on-battery) drops idle blocker (when 0 turns) AND immediately reverts disablesleep to 0!
  battery = true;
  powerMonitor.emit("on-battery");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(guard.state.holdingIdleBlocker, false);
  assert.equal(guard.state.chargerSleepDisabledApplied, false);
  assert.deepEqual(pmsetCalls, [true, false]);

  // 4. Starting an active agent turn on battery holds prevent-app-suspension until the turn finishes,
  //    without re-applying clamshell disablesleep on battery
  guard.setActiveTurns(1);
  assert.equal(guard.state.holdingIdleBlocker, true);
  assert.equal(guard.state.chargerSleepDisabledApplied, false);
  guard.setActiveTurns(0);
  assert.equal(guard.state.holdingIdleBlocker, false);

  // 5. Plugging AC back in restores both idle blocker and AC clamshell setting
  battery = false;
  powerMonitor.emit("on-ac");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(guard.state.holdingIdleBlocker, true);
  assert.equal(guard.state.chargerSleepDisabledApplied, true);
  assert.deepEqual(pmsetCalls, [true, false, true]);

  // 6. Lid close / system suspend emits immediate host_sleeping notice
  powerMonitor.emit("suspend");
  assert.deepEqual(suspendNotices, [{ at: "2026-11-27T09:50:00.000Z", reason: "suspend" }]);

  // 7. Disposing releases blocker and clears charger disablesleep
  await guard.dispose();
  assert.equal(activeBlockers.size, 0);
  assert.deepEqual(pmsetCalls, [true, false, true, false]);
});
