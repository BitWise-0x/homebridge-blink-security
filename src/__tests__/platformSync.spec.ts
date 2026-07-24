import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlinkSecurityPlatform } from '../platform.js';
import type {
  API,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

/**
 * Minimal HAP/Homebridge doubles. The platform only needs uuid generation,
 * a PlatformAccessory constructor, and the register/unregister hooks.
 */
function makeApi(): {
  api: API;
  registered: PlatformAccessory[][];
  unregistered: PlatformAccessory[][];
  finishLaunching: () => void;
} {
  const registered: PlatformAccessory[][] = [];
  const unregistered: PlatformAccessory[][] = [];
  let finish: () => void = () => {};

  class FakeAccessory {
    displayName: string;
    UUID: string;
    context: Record<string, unknown> = {};
    services: unknown[] = [];
    constructor(displayName: string, uuid: string) {
      this.displayName = displayName;
      this.UUID = uuid;
    }
    getService() {
      return undefined;
    }
    addService(service: unknown) {
      this.services.push(service);
      return service;
    }
    removeService() {}
    configureController() {}
  }

  const api = {
    hap: {
      uuid: { generate: (s: string) => `uuid-${s}` },
      Characteristic: new Proxy({}, { get: () => 'characteristic' }),
      Service: new Proxy({}, { get: () => 'service' }),
      CameraController: class {},
      SRTPCryptoSuites: {
        AES_CM_128_HMAC_SHA1_80: 0,
        AES_CM_256_HMAC_SHA1_80: 1,
        NONE: 2,
      },
      H264Profile: { BASELINE: 0, MAIN: 1, HIGH: 2 },
      H264Level: { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 },
      AudioStreamingCodecType: { AAC_ELD: 'AAC-eld', OPUS: 'OPUS' },
      AudioStreamingSamplerate: { KHZ_8: 8, KHZ_16: 16, KHZ_24: 24 },
      AudioRecordingCodecType: { AAC_LC: 0, AAC_ELD: 1 },
      AudioRecordingSamplerate: { KHZ_16: 0, KHZ_24: 1, KHZ_32: 2 },
      VideoCodecType: { H264: 0 },
      MediaContainerType: { FRAGMENTED_MP4: 0 },
    },
    platformAccessory: FakeAccessory,
    user: { storagePath: () => '/tmp/blink-test' },
    on: (event: string, cb: () => void) => {
      if (event === 'didFinishLaunching') {
        finish = cb;
      }
    },
    registerPlatformAccessories: (
      _p: string,
      _n: string,
      accs: PlatformAccessory[]
    ) => {
      registered.push(accs);
    },
    unregisterPlatformAccessories: (
      _p: string,
      _n: string,
      accs: PlatformAccessory[]
    ) => {
      unregistered.push(accs);
    },
  } as unknown as API;

  return { api, registered, unregistered, finishLaunching: () => finish() };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const config = {
  platform: 'BlinkSecurity',
  username: 'u@example.com',
  password: 'p',
  'hide-alarm': true,
  'hide-manual-arm-switch': true,
  'hide-doorbells': true,
} as unknown as PlatformConfig;

/**
 * Substitutes lightweight accessory doubles for the real HAP-backed ones so
 * the reconcile logic is what is under test.
 */
class TestPlatform extends BlinkSecurityPlatform {
  private make(device: { canonicalID: string; name: string }) {
    const uuid = `uuid-${device.canonicalID}`;
    const accessory = {
      UUID: uuid,
      displayName: `Blink ${device.name}`,
      context: { canonicalID: device.canonicalID },
    } as unknown as PlatformAccessory;
    return {
      platformAccessory: accessory,
      updateState: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }
  protected override buildCameraAccessory(camera: never) {
    return this.make(camera) as never;
  }
  protected override buildDoorbellAccessory(doorbell: never) {
    return this.make(doorbell) as never;
  }
  protected override buildSecurityAccessory(network: never) {
    return this.make(network) as never;
  }
  protected override buildSirenAccessory(siren: never) {
    return this.make(siren) as never;
  }
}

describe('BlinkSecurityPlatform accessory sync', () => {
  let harness: ReturnType<typeof makeApi>;
  let platform: BlinkSecurityPlatform;

  beforeEach(() => {
    harness = makeApi();
    platform = new TestPlatform(makeLogger(), config, harness.api);
  });

  function cameras(...ids: number[]) {
    return new Map(
      ids.map(id => [
        id,
        {
          canonicalID: `Blink:Network:100:Camera:${id}`,
          name: `Cam ${id}`,
          cameraID: id,
          networkID: 100,
          isBatteryPower: false,
          isCameraMini: false,
          model: 'camera',
          serial: `S${id}`,
          firmware: '1',
          context: {},
        },
      ])
    );
  }

  function setBlink(cameraIds: number[]) {
    (platform as unknown as { blink: unknown }).blink = {
      networks: new Map(),
      cameras: cameras(...cameraIds),
      doorbells: new Map(),
      sirens: new Map(),
    };
  }

  function sync() {
    return (
      platform as unknown as { syncAccessories: () => void }
    ).syncAccessories();
  }

  it('registers accessories for the initial device set', () => {
    setBlink([1, 2]);
    sync();
    const names = harness.registered.flat().map(a => a.displayName);
    expect(names).toHaveLength(2);
  });

  // A device added to the Blink account while Homebridge runs must reach
  // HomeKit on the next sync rather than waiting for a restart.
  it('registers only the newly added device on a later sync', () => {
    setBlink([1]);
    sync();
    harness.registered.length = 0;

    setBlink([1, 2]);
    sync();

    const names = harness.registered.flat().map(a => a.displayName);
    expect(names).toEqual(['Blink Cam 2']);
  });

  // Re-registering an existing accessory would duplicate it in HomeKit, and
  // rebuilding its accessory would attach a second camera controller.
  it('does not re-register or rebuild an existing accessory', () => {
    setBlink([1]);
    sync();
    const first = harness.registered.flat()[0];
    harness.registered.length = 0;

    setBlink([1]);
    sync();

    expect(harness.registered).toHaveLength(0);
    expect(harness.unregistered).toHaveLength(0);
    // Same accessory object is reused, so its controller is untouched.
    const accessories = (
      platform as unknown as {
        cameraAccessories: { platformAccessory: unknown }[];
      }
    ).cameraAccessories;
    expect(accessories).toHaveLength(1);
    expect(accessories[0].platformAccessory).toBe(first);
  });

  it('unregisters an accessory whose device disappeared', () => {
    setBlink([1, 2]);
    sync();
    harness.registered.length = 0;

    setBlink([1]);
    sync();

    const removed = harness.unregistered.flat().map(a => a.displayName);
    expect(removed).toEqual(['Blink Cam 2']);
  });

  // A removed accessory's delegate still owns ffmpeg children and proxy
  // servers; nothing else will release them.
  it('tears down an accessory whose device disappeared', () => {
    setBlink([1, 2]);
    sync();
    const wrappers = (
      platform as unknown as {
        cameraAccessories: { shutdown: ReturnType<typeof vi.fn> }[];
      }
    ).cameraAccessories;
    const removed = wrappers[1];

    setBlink([1]);
    sync();

    expect(removed.shutdown).toHaveBeenCalledOnce();
  });

  it('stops pushing updates to a removed accessory', () => {
    setBlink([1, 2]);
    sync();
    setBlink([1]);
    sync();

    const accessories = (
      platform as unknown as { cameraAccessories: unknown[] }
    ).cameraAccessories;
    expect(accessories).toHaveLength(1);
  });

  // Unregistering takes the user's room assignments, names, scenes and
  // automations with it. An account reporting zero devices is far more
  // likely to be a transient API problem than a real mass deletion.
  it('keeps accessories when the device set comes back empty', () => {
    setBlink([1, 2]);
    sync();
    harness.registered.length = 0;

    setBlink([]);
    sync();

    expect(harness.unregistered).toHaveLength(0);
  });

  // Removing then re-adding a device must not leave the platform believing
  // the accessory is still registered.
  it('re-registers a device that was removed and added back', () => {
    // Keep a second device throughout: an entirely empty set is treated as a
    // transient fault and deliberately does not unregister anything.
    setBlink([1, 2]);
    sync();
    setBlink([2]);
    sync();
    harness.registered.length = 0;

    setBlink([1, 2]);
    sync();

    const names = harness.registered.flat().map(a => a.displayName);
    expect(names).toEqual(['Blink Cam 1']);
  });

  // A hung or failed status refresh must not stall motion delivery. The
  // motion getters fetch the media list through their own cached request
  // path, so updates can and must still be pushed after a refresh error.
  it('still pushes accessory updates when the status refresh fails', async () => {
    vi.useFakeTimers();
    try {
      setBlink([1]);
      sync();
      const p = platform as unknown as {
        blink: { refreshData?: unknown };
        poll: () => Promise<void>;
        pollTimer?: NodeJS.Timeout;
        cameraAccessories: { updateState: ReturnType<typeof vi.fn> }[];
      };
      p.blink.refreshData = vi.fn().mockRejectedValue(new Error('timeout'));

      await p.poll();

      expect(p.cameraAccessories[0].updateState).toHaveBeenCalled();
      if (p.pollTimer) {
        clearTimeout(p.pollTimer);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The real accessory constructors look their PlatformAccessory up in
 * `cachedAccessories` by UUID and then call `configureController()` on it.
 * A double that always mints a fresh object cannot observe a rebuild, so
 * this one reuses like the real thing and records each configure call.
 */
describe('BlinkSecurityPlatform accessory rebuild safety', () => {
  it('never configures a camera controller twice for one accessory', () => {
    const harness = makeApi();
    const configured: string[] = [];

    class RealisticPlatform extends BlinkSecurityPlatform {
      private cache(): PlatformAccessory[] {
        return (this as unknown as { cachedAccessories: PlatformAccessory[] })
          .cachedAccessories;
      }
      private make(device: { canonicalID: string; name: string }) {
        const uuid = `uuid-${device.canonicalID}`;
        let accessory = this.cache().find(a => a.UUID === uuid);
        if (!accessory) {
          accessory = {
            UUID: uuid,
            displayName: `Blink ${device.name}`,
            context: {} as Record<string, unknown>,
          } as unknown as PlatformAccessory;
        }
        accessory.context.canonicalID = device.canonicalID;
        // Mirrors the guard the real accessories apply.
        if (!accessory.context._controllerConfigured) {
          accessory.context._controllerConfigured = true;
          configured.push(uuid);
        }
        return {
          platformAccessory: accessory,
          updateState: vi.fn(),
          shutdown: vi.fn().mockResolvedValue(undefined),
        };
      }
      protected override buildCameraAccessory(camera: never) {
        return this.make(camera) as never;
      }
      protected override buildDoorbellAccessory(doorbell: never) {
        return this.make(doorbell) as never;
      }
      protected override buildSecurityAccessory(network: never) {
        return this.make(network) as never;
      }
      protected override buildSirenAccessory(siren: never) {
        return this.make(siren) as never;
      }
    }

    const platform = new RealisticPlatform(makeLogger(), config, harness.api);
    const cameras = new Map([
      [1, { canonicalID: 'Blink:Network:100:Camera:1', name: 'Cam 1' }],
    ]);
    (platform as unknown as { blink: unknown }).blink = {
      networks: new Map(),
      cameras,
      doorbells: new Map(),
      sirens: new Map(),
    };
    const sync = () =>
      (
        platform as unknown as { syncAccessories: () => void }
      ).syncAccessories();
    const cfg = (platform as unknown as { config: Record<string, unknown> })
      .config;

    sync();
    // Hiding cameras drops the wrapper, so the next pass rebuilds against
    // the same recycled PlatformAccessory.
    cfg.noCameras = true;
    sync();
    cfg.noCameras = false;
    sync();

    expect(configured).toEqual(['uuid-Blink:Network:100:Camera:1']);
  });
});
