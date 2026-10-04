import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const GRACE_MS = 5 * 60 * 1000;

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
    vi.useFakeTimers({ toFake: ['Date'] });
    harness = makeApi();
    platform = new TestPlatform(makeLogger(), config, harness.api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the removal grace period pass, then reconcile again. */
  function syncAfterGrace() {
    vi.setSystemTime(Date.now() + GRACE_MS);
    sync();
  }

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
      unresolvedDevices: new Set<string>(),
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

  // One response that leaves a device out is not proof it was removed.
  // Blink has to keep omitting it, while still listing others of its kind.
  it('unregisters an accessory once its device stays gone', () => {
    setBlink([1, 2]);
    sync();
    harness.registered.length = 0;

    setBlink([1]);
    sync();
    expect(harness.unregistered).toHaveLength(0);

    syncAfterGrace();

    const removed = harness.unregistered.flat().map(a => a.displayName);
    expect(removed).toEqual(['Blink Cam 2']);
  });

  it('keeps an accessory whose device comes back in time', () => {
    setBlink([1, 2]);
    sync();
    harness.registered.length = 0;

    setBlink([1]);
    sync();
    setBlink([1, 2]);
    sync();
    syncAfterGrace();

    expect(harness.unregistered).toHaveLength(0);
    expect(harness.registered).toHaveLength(0);
  });

  it('restarts the grace period when a device goes missing again', () => {
    setBlink([1, 2]);
    sync();
    setBlink([1]);
    sync();
    setBlink([1, 2]);
    sync();

    vi.setSystemTime(Date.now() + GRACE_MS);
    setBlink([1]);
    sync();

    expect(harness.unregistered).toHaveLength(0);
  });

  it('asks for a reconcile once a removal comes due', () => {
    const due = () =>
      (platform as unknown as { removalDue: () => boolean }).removalDue();
    setBlink([1, 2]);
    sync();
    setBlink([1]);
    sync();
    expect(due()).toBe(false);

    vi.setSystemTime(Date.now() + GRACE_MS);
    expect(due()).toBe(true);
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
    syncAfterGrace();
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
    const camera = (id: number) =>
      [
        id,
        { canonicalID: `Blink:Network:100:Camera:${id}`, name: `Cam ${id}` },
      ] as const;
    const setCameras = (...ids: number[]) => {
      (platform as unknown as { blink: unknown }).blink = {
        networks: new Map(),
        cameras: new Map(ids.map(camera)),
        doorbells: new Map(),
        sirens: new Map(),
        unresolvedDevices: new Set<string>(),
      };
    };
    const sync = () =>
      (
        platform as unknown as { syncAccessories: () => void }
      ).syncAccessories();

    setCameras(1, 2);
    sync();
    // A device that drops out and returns inside the grace period loses its
    // wrapper, so the next pass rebuilds against the same recycled
    // PlatformAccessory.
    setCameras(2);
    sync();
    setCameras(1, 2);
    sync();

    expect(configured).toEqual([
      'uuid-Blink:Network:100:Camera:1',
      'uuid-Blink:Network:100:Camera:2',
    ]);
  });
});

// Unregistering discards HomeKit state nothing can restore, so a cached
// accessory is only given up on evidence that its device is gone.
describe('BlinkSecurityPlatform cached accessory retention', () => {
  const visibleDoorbells = {
    ...config,
    'hide-doorbells': false,
  } as unknown as PlatformConfig;

  function cached(canonicalID: string, name: string): PlatformAccessory {
    return {
      UUID: `uuid-${canonicalID}`,
      displayName: `Blink ${name}`,
      context: { canonicalID },
    } as unknown as PlatformAccessory;
  }

  function device(canonicalID: string, name: string) {
    return { canonicalID, name };
  }

  function setup(
    platformConfig: PlatformConfig,
    restored: PlatformAccessory[]
  ) {
    const harness = makeApi();
    const log = makeLogger();
    const platform = new TestPlatform(log, platformConfig, harness.api);
    for (const accessory of restored) {
      platform.configureAccessory(accessory);
    }
    const unresolvedDevices = new Set<string>();
    const blink = {
      networks: new Map(),
      cameras: new Map([[1, device('Blink:Network:100:Camera:1', 'Cam 1')]]),
      doorbells: new Map<number, unknown>(),
      sirens: new Map(),
      unresolvedDevices,
    };
    (platform as unknown as { blink: unknown }).blink = blink;
    const syncPastGrace = () => {
      const internals = platform as unknown as { syncAccessories: () => void };
      internals.syncAccessories();
      vi.setSystemTime(Date.now() + GRACE_MS);
      internals.syncAccessories();
    };
    return { harness, log, platform, blink, syncPastGrace };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const doorbellID = 'Blink:Network:100:Doorbell:9';

  // The #76 analysis case: at startup the first refresh produced cameras but
  // no doorbell, and the cached doorbell accessory was unregistered.
  it('keeps a kind of accessory Blink reports none of', () => {
    const { harness, log, syncPastGrace } = setup(visibleDoorbells, [
      cached(doorbellID, 'Front Door'),
    ]);

    syncPastGrace();

    expect(harness.unregistered).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Blink Front Door')
    );
  });

  it('keeps an accessory whose device Blink gave no verdict on', () => {
    const { harness, blink, syncPastGrace } = setup(visibleDoorbells, [
      cached(doorbellID, 'Front Door'),
    ]);
    blink.doorbells.set(8, device('Blink:Network:100:Doorbell:8', 'Back Door'));
    blink.unresolvedDevices.add(doorbellID);

    syncPastGrace();

    expect(harness.unregistered).toHaveLength(0);
  });

  it('removes an accessory Blink keeps leaving out of a kind it reports', () => {
    const { harness, blink, syncPastGrace } = setup(visibleDoorbells, [
      cached(doorbellID, 'Front Door'),
    ]);
    blink.doorbells.set(8, device('Blink:Network:100:Doorbell:8', 'Back Door'));

    syncPastGrace();

    const removed = harness.unregistered.flat().map(a => a.displayName);
    expect(removed).toEqual(['Blink Front Door']);
  });

  it('removes a hidden kind at once', () => {
    const { harness, platform } = setup(config, [
      cached(doorbellID, 'Front Door'),
    ]);

    (platform as unknown as { syncAccessories: () => void }).syncAccessories();

    const removed = harness.unregistered.flat().map(a => a.displayName);
    expect(removed).toEqual(['Blink Front Door']);
  });

  it('removes an accessory with no current identity at once', () => {
    const { harness, platform } = setup(visibleDoorbells, [
      cached('Blink:Device:100', 'Legacy'),
    ]);

    (platform as unknown as { syncAccessories: () => void }).syncAccessories();

    const removed = harness.unregistered.flat().map(a => a.displayName);
    expect(removed).toEqual(['Blink Legacy']);
  });

  it('hands cached doorbells to the device layer by ID', () => {
    const { platform } = setup(visibleDoorbells, [
      cached(doorbellID, 'Front Door'),
      cached('Blink:Network:100:Camera:1', 'Cam 1'),
    ]);

    const doorbells = (
      platform as unknown as { cachedDoorbells: () => unknown[] }
    ).cachedDoorbells();

    expect(doorbells).toEqual([
      {
        id: 9,
        networkID: 100,
        canonicalID: doorbellID,
        displayName: 'Blink Front Door',
      },
    ]);
  });
});
