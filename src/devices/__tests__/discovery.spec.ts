import { describe, it, expect, vi } from 'vitest';
import { Blink } from '../index.js';
import { DEFAULT_OPTIONS } from '../../lib/config.js';
import type { BlinkAuthClient } from '../../lib/auth.js';
import type { Logger } from 'homebridge';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeDevice(id: number, name: string, type = 'camera') {
  return {
    id,
    network_id: 100,
    name,
    serial: `TEST${id}`,
    fw_version: '1.0.0',
    type,
    enabled: true,
    thumbnail: '',
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeHomescreen(overrides: Record<string, unknown> = {}) {
  return {
    networks: [{ id: 100, name: 'Blink Home', armed: false }],
    sync_modules: [{ id: 555, network_id: 100, status: 'online' }],
    cameras: [makeDevice(42, 'Front Door')],
    owls: [],
    doorbells: [],
    doorbell_buttons: [],
    sirens: [],
    ...overrides,
  };
}

function makeBlink(homescreen: Record<string, unknown>) {
  const log = makeLogger();
  const blink = new Blink(
    { isAuthenticated: false } as unknown as BlinkAuthClient,
    log,
    30,
    15,
    3600,
    { ...DEFAULT_OPTIONS, localStorageMotion: 'never' }
  );
  const api = {
    getAccountHomescreen: vi.fn().mockResolvedValue(homescreen),
    getMediaChange: vi.fn().mockResolvedValue({ media: [] }),
    getDoorbellConfig: vi.fn().mockResolvedValue({}),
  };
  Object.defineProperty(blink, 'api', { value: api });
  return { blink, api, log };
}

describe('Blink.refreshData device discovery', () => {
  it('routes owl-array members through the owl endpoints', async () => {
    const { blink } = makeBlink(
      makeHomescreen({
        cameras: [],
        owls: [makeDevice(7, 'Mini', 'somefuturebird')],
      })
    );
    await blink.refreshData();
    expect(blink.cameras.get(7)!.isCameraMini).toBe(true);
  });

  it('does not route a plain camera through the owl endpoints', async () => {
    const { blink } = makeBlink(
      makeHomescreen({ cameras: [makeDevice(42, 'Yard', 'chickadee')] })
    );
    await blink.refreshData();
    // Codename alone must never force owl routing (#40, #51 inverse).
    expect(blink.cameras.get(42)!.isCameraMini).toBe(false);
  });

  // Blink added `owls` as a sibling of `cameras` for the Mini family. A
  // future family arriving the same way must not vanish without a trace.
  it('warns about devices in an unrecognized homescreen group', async () => {
    const { blink, log } = makeBlink(
      makeHomescreen({ sonorans: [makeDevice(8, 'New Cam', 'sonoran')] })
    );
    await blink.refreshData();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized "sonorans" group')
    );
  });

  it('warns only once for the same unrecognized group', async () => {
    const { blink, log } = makeBlink(
      makeHomescreen({ sonorans: [makeDevice(8, 'New Cam', 'sonoran')] })
    );
    await blink.refreshData();
    await blink.refreshData();
    const warnings = (log.warn as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(warnings.length).toBe(1);
  });

  // Blink's homescreen carries several collections that are not cameras and
  // never will be. Warning about them tells the user to file a report for
  // hardware this plugin has no business exposing.
  it('does not warn about known non-camera collections', async () => {
    const { blink, log } = makeBlink(
      makeHomescreen({
        chimes: [{ id: 1, network_id: 100, name: 'Chime' }],
        ring_devices: [
          { id: 2, name: 'Ring 1' },
          { id: 3, name: 'Ring 2' },
        ],
        accessories: [{ id: 4, name: 'Accessory' }],
        app_updates: [{ id: 5 }],
        subscriptions: [{ id: 6 }],
        entitlements: [{ id: 7 }],
        tiv_lock_status: [{ id: 8 }],
        device_limits: [{ id: 9 }],
        whats_new: [{ id: 10 }],
      })
    );
    await blink.refreshData();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not warn about non-device collections', async () => {
    const { blink, log } = makeBlink(
      makeHomescreen({ subscriptions: [{ plan: 'free' }] })
    );
    await blink.refreshData();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('tracks a camera added to the account after startup', async () => {
    const { blink, api } = makeBlink(makeHomescreen());
    await blink.refreshData();
    expect(blink.cameras.size).toBe(1);

    api.getAccountHomescreen.mockResolvedValue(
      makeHomescreen({
        cameras: [makeDevice(42, 'Front Door'), makeDevice(43, 'Side Yard')],
      })
    );
    await blink.refreshData();
    expect(blink.cameras.has(43)).toBe(true);
  });

  // A device deleted in the Blink app must stop being tracked, otherwise it
  // keeps a HomeKit accessory and keeps being polled forever.
  it('drops a camera removed from the account', async () => {
    const { blink, api } = makeBlink(
      makeHomescreen({
        cameras: [makeDevice(42, 'Front Door'), makeDevice(43, 'Side Yard')],
      })
    );
    await blink.refreshData();
    expect(blink.cameras.size).toBe(2);

    api.getAccountHomescreen.mockResolvedValue(
      makeHomescreen({ cameras: [makeDevice(42, 'Front Door')] })
    );
    await blink.refreshData();

    expect(blink.cameras.has(43)).toBe(false);
    expect(blink.cameras.has(42)).toBe(true);
  });

  // Losing every device at once is far more likely to be an API or auth
  // problem than a real mass deletion, and dropping them would tear down the
  // user's HomeKit setup.
  it('keeps devices when the homescreen reports none', async () => {
    const { blink, api } = makeBlink(makeHomescreen());
    await blink.refreshData();

    api.getAccountHomescreen.mockResolvedValue(
      makeHomescreen({ cameras: [], owls: [] })
    );
    await blink.refreshData();

    expect(blink.cameras.has(42)).toBe(true);
  });

  // Doorbells found through the media fallback never appear in the
  // homescreen, so pruning must not treat their absence as a removal.
  it('keeps a fallback-discovered doorbell absent from the homescreen', async () => {
    const { blink, api } = makeBlink(makeHomescreen());
    api.getMediaChange.mockResolvedValue({
      media: [
        {
          id: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          device_id: 99,
          network_id: 100,
          device: 'lotus',
          thumbnail: '',
        },
      ],
    });
    api.getDoorbellConfig.mockResolvedValue({
      id: 99,
      network_id: 100,
      name: 'Front Doorbell',
    });

    await blink.refreshData();
    expect(blink.doorbells.has(99)).toBe(true);

    await blink.refreshData();
    expect(blink.doorbells.has(99)).toBe(true);
  });

  it('drops a siren removed from the account', async () => {
    const { blink, api } = makeBlink(
      makeHomescreen({
        sirens: [
          { id: 7, network_id: 100, name: 'Siren' },
          { id: 8, network_id: 100, name: 'Siren 2' },
        ],
      })
    );
    await blink.refreshData();
    expect(blink.sirens.size).toBe(2);

    api.getAccountHomescreen.mockResolvedValue(
      makeHomescreen({ sirens: [{ id: 7, network_id: 100, name: 'Siren' }] })
    );
    await blink.refreshData();

    expect(blink.sirens.has(8)).toBe(false);
    expect(blink.sirens.has(7)).toBe(true);
  });

  // An empty list for one device kind is a partial response, not a mass
  // deletion: keeping the devices is recoverable, deleting them is not.
  it('keeps sirens when the homescreen reports none of them', async () => {
    const { blink, api } = makeBlink(
      makeHomescreen({ sirens: [{ id: 7, network_id: 100, name: 'Siren' }] })
    );
    await blink.refreshData();

    api.getAccountHomescreen.mockResolvedValue(makeHomescreen({ sirens: [] }));
    await blink.refreshData();

    expect(blink.sirens.has(7)).toBe(true);
  });

  // A pruned camera must not leave its local-storage entry behind, or the
  // stale clip keeps being merged into motion lookups.
  it('clears local media for a pruned camera', async () => {
    const { blink, api } = makeBlink(
      makeHomescreen({
        cameras: [makeDevice(42, 'Front Door'), makeDevice(43, 'Side Yard')],
      })
    );
    await blink.refreshData();
    (blink as unknown as { localMedia: Map<number, unknown> }).localMedia.set(
      43,
      { entry: {}, discoveredAt: Date.now() }
    );

    api.getAccountHomescreen.mockResolvedValue(
      makeHomescreen({ cameras: [makeDevice(42, 'Front Door')] })
    );
    await blink.refreshData();

    expect(
      (blink as unknown as { localMedia: Map<number, unknown> }).localMedia.has(
        43
      )
    ).toBe(false);
  });

  it('drops a network removed from the account', async () => {
    const { blink, api } = makeBlink(
      makeHomescreen({
        networks: [
          { id: 100, name: 'Home', armed: false },
          { id: 200, name: 'Cabin', armed: false },
        ],
      })
    );
    await blink.refreshData();
    expect(blink.networks.size).toBe(2);

    api.getAccountHomescreen.mockResolvedValue(
      makeHomescreen({ networks: [{ id: 100, name: 'Home', armed: false }] })
    );
    await blink.refreshData();

    expect(blink.networks.has(200)).toBe(false);
    expect(blink.networks.has(100)).toBe(true);
  });

  // A new camera family arriving in its own collection must be reported even
  // if it does not use the exact field names the known collections use.
  it('warns about a camera-shaped group under an unfamiliar key', async () => {
    const { blink, log } = makeBlink(
      makeHomescreen({
        gadgets: [
          {
            id: 5,
            network_id: 100,
            name: 'Gadget',
            serial: 'G5',
            type: 'newbird',
          },
        ],
      })
    );
    await blink.refreshData();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized "gadgets" group')
    );
  });

  // The media-based fallback previously matched only the hardcoded "lotus"
  // codename, so any newer doorbell revision was invisible on accounts whose
  // homescreen doorbell arrays come back empty.
  it('discovers a doorbell whose codename is not the known one', async () => {
    const { blink, api } = makeBlink(makeHomescreen());
    api.getMediaChange.mockResolvedValue({
      media: [
        {
          id: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          device_id: 99,
          network_id: 100,
          device: 'orchid',
          thumbnail: '',
        },
      ],
    });
    api.getDoorbellConfig.mockResolvedValue({
      id: 99,
      network_id: 100,
      name: 'Front Doorbell',
    });

    await blink.refreshData();
    expect(blink.doorbells.has(99)).toBe(true);
  });

  it('does not treat a known camera as a doorbell candidate', async () => {
    const { blink, api } = makeBlink(makeHomescreen());
    api.getMediaChange.mockResolvedValue({
      media: [
        {
          id: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          device_id: 42,
          network_id: 100,
          device: 'camera',
          thumbnail: '',
        },
      ],
    });

    await blink.refreshData();
    expect(blink.doorbells.has(42)).toBe(false);
    expect(api.getDoorbellConfig).not.toHaveBeenCalled();
  });
});
