import { describe, it, expect, vi } from 'vitest';
import { SecuritySystemAccessory } from '../securitySystem.js';
import type { API, Logger, PlatformAccessory } from 'homebridge';
import type { BlinkNetwork } from '../../devices/network.js';
import type { BlinkOptions } from '../../lib/config.js';

const CurrentState = {
  STAY_ARM: 0,
  AWAY_ARM: 1,
  NIGHT_ARM: 2,
  DISARMED: 3,
  ALARM_TRIGGERED: 4,
};
const TargetState = { STAY_ARM: 0, AWAY_ARM: 1, NIGHT_ARM: 2, DISARM: 3 };

class FakeService {
  updates: Array<{ characteristic: unknown; value: unknown }> = [];
  getCharacteristic() {
    const chain = {
      onGet: () => chain,
      onSet: () => chain,
      setProps: () => chain,
    };
    return chain;
  }
  setCharacteristic() {
    return this;
  }
  addOptionalCharacteristic() {}
  updateCharacteristic(characteristic: unknown, value: unknown) {
    this.updates.push({ characteristic, value });
  }
}

function makeHarness(opts: {
  armed: boolean;
  motion: boolean;
  alarmTriggering?: boolean;
}) {
  const securityService = new FakeService();
  const accessory = {
    UUID: 'uuid-net',
    context: {},
    getService: () => undefined,
    addService: () => securityService,
    getServiceById: () => undefined,
    removeService: () => {},
  } as unknown as PlatformAccessory;

  const api = {
    hap: {
      Characteristic: {
        SecuritySystemCurrentState: CurrentState,
        SecuritySystemTargetState: TargetState,
        Name: 'Name',
        Manufacturer: 'Manufacturer',
        FirmwareRevision: 'FirmwareRevision',
        Model: 'Model',
        SerialNumber: 'SerialNumber',
        ConfiguredName: 'ConfiguredName',
        On: 'On',
      },
      Service: {
        SecuritySystem: 'SecuritySystem',
        AccessoryInformation: 'AccessoryInformation',
        Switch: 'Switch',
      },
      uuid: { generate: () => 'uuid-net' },
    },
    platformAccessory: class {},
  } as unknown as API;

  const getMotionDetected = vi.fn().mockResolvedValue(opts.motion);
  const network = {
    canonicalID: 'Blink:Network:100',
    name: 'Blink Home',
    armed: opts.armed,
    // Long past the post-arm quiet window so the escalation is eligible.
    armedAt: Date.now() - 10 * 60 * 1000,
    updatedAt: 0,
    context: {},
    cameras: [{ getMotionDetected }],
  } as unknown as BlinkNetwork;

  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const config = {
    noAlarm: false,
    noManualArmSwitch: true,
    alarmTriggering: opts.alarmTriggering ?? false,
  } as unknown as BlinkOptions;

  const sa = new SecuritySystemAccessory(network, api, log, config, [
    accessory,
  ]);
  const push = () =>
    (
      sa as unknown as { pushStateUpdate: () => Promise<void> }
    ).pushStateUpdate();
  return { securityService, push, getMotionDetected };
}

function lastValue(service: FakeService, characteristic: unknown) {
  return service.updates.filter(u => u.characteristic === characteristic).at(-1)
    ?.value;
}

describe('SecuritySystemAccessory.pushStateUpdate', () => {
  // The pushed state must match what an onGet read reports. Pushing the
  // base armed state while reads return ALARM_TRIGGERED made HomeKit
  // oscillate, re-announcing "triggered" and "set to away" on every poll
  // cycle for the whole motion decay window.
  it('pushes ALARM_TRIGGERED while armed with active motion', async () => {
    const { securityService, push } = makeHarness({
      armed: true,
      motion: true,
      alarmTriggering: true,
    });
    await push();
    expect(lastValue(securityService, CurrentState)).toBe(
      CurrentState.ALARM_TRIGGERED
    );
  });

  it('never pushes the triggered escalation into the target state', async () => {
    const { securityService, push } = makeHarness({
      armed: true,
      motion: true,
      alarmTriggering: true,
    });
    await push();
    expect(lastValue(securityService, TargetState)).toBe(CurrentState.AWAY_ARM);
  });

  it('pushes the armed state while armed without motion', async () => {
    const { securityService, push } = makeHarness({
      armed: true,
      motion: false,
      alarmTriggering: true,
    });
    await push();
    expect(lastValue(securityService, CurrentState)).toBe(
      CurrentState.AWAY_ARM
    );
  });

  // Escalation is opt-in: the triggered alert outranks per-camera motion
  // notifications in HomeKit, so by default motion must only fire the
  // camera sensors and the security system stays at its armed state.
  it('does not escalate motion when alarm triggering is disabled', async () => {
    const { securityService, push, getMotionDetected } = makeHarness({
      armed: true,
      motion: true,
    });
    await push();
    expect(lastValue(securityService, CurrentState)).toBe(
      CurrentState.AWAY_ARM
    );
    expect(getMotionDetected).not.toHaveBeenCalled();
  });

  it('pushes disarmed without consulting motion', async () => {
    const { securityService, push, getMotionDetected } = makeHarness({
      armed: false,
      motion: true,
    });
    await push();
    expect(lastValue(securityService, CurrentState)).toBe(
      CurrentState.DISARMED
    );
    expect(getMotionDetected).not.toHaveBeenCalled();
  });
});
