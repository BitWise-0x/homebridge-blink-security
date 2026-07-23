import { describe, it, expect, vi } from 'vitest';
import { Blink, BlinkCamera, LOCAL_STORAGE_POLL } from '../index.js';
import type { HomescreenCamera } from '../base.js';
import type { BlinkAuthClient } from '../../lib/auth.js';
import type { BlinkOptions } from '../../lib/config.js';
import { DEFAULT_OPTIONS } from '../../lib/config.js';
import type { Logger } from 'homebridge';

interface PollState {
  nextPollAt: number;
  inFlight: boolean;
  backoff: { attempt: number };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeCameraData(id: number, name: string): HomescreenCamera {
  return {
    id,
    network_id: 100,
    name,
    serial: `TEST${id}`,
    fw_version: '1.0.0',
    type: 'camera',
    enabled: true,
    thumbnail: '',
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeSyncModule(overrides: Record<string, unknown> = {}) {
  return {
    id: 555,
    network_id: 100,
    status: 'online',
    local_storage_enabled: true,
    local_storage_compatible: true,
    local_storage_status: 'active',
    ...overrides,
  };
}

interface Harness {
  blink: Blink;
  log: Logger;
  api: {
    getMediaChange: ReturnType<typeof vi.fn>;
    lock: ReturnType<typeof vi.fn>;
    command: ReturnType<typeof vi.fn>;
    requestLocalStorageManifest: ReturnType<typeof vi.fn>;
    getLocalStorageManifest: ReturnType<typeof vi.fn>;
  };
  poll: () => Promise<void>;
  state: () => PollState | undefined;
}

function makeHarness(
  options: Partial<BlinkOptions> = {},
  syncModule: Record<string, unknown> | undefined = makeSyncModule()
): Harness {
  const log = makeLogger();
  const blink = new Blink(
    { isAuthenticated: false } as unknown as BlinkAuthClient,
    log,
    30,
    15,
    3600,
    { ...DEFAULT_OPTIONS, ...options }
  );

  const api = {
    getMediaChange: vi.fn().mockResolvedValue({ media: [] }),
    lock: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn()
    ),
    command: vi.fn(async (_networkID: number, fn: () => Promise<unknown>) => {
      await fn();
      return { complete: true };
    }),
    requestLocalStorageManifest: vi.fn().mockResolvedValue({ id: 777 }),
    getLocalStorageManifest: vi.fn().mockResolvedValue({
      manifest_id: 'm1',
      clips: [
        {
          id: '1',
          camera_name: 'FrontDoor',
          created_at: new Date().toISOString(),
        },
      ],
    }),
  };
  Object.defineProperty(blink, 'api', { value: api });

  blink.networks.set(100, {
    networkID: 100,
    name: 'Blink Home',
    syncModule,
  } as never);
  // Register one camera whose name matches the manifest clip
  blink.cameras.set(
    42,
    new BlinkCamera(makeCameraData(42, 'Front Door'), blink)
  );

  const poll = () =>
    (
      blink as unknown as { pollLocalStorage: () => Promise<void> }
    ).pollLocalStorage();

  const state = () =>
    (
      blink as unknown as {
        localStorageState: Map<number, PollState>;
      }
    ).localStorageState.get(100);

  return { blink, log, api, poll, state };
}

async function flush(): Promise<void> {
  // Let the fire-and-forget manifest chain settle
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('Blink.pollLocalStorage', () => {
  it('defers the first manifest attempt past the startup window', async () => {
    const { api, poll, state } = makeHarness();
    await poll();
    await flush();

    expect(state()!.nextPollAt).toBeGreaterThan(Date.now());
    expect(api.requestLocalStorageManifest).not.toHaveBeenCalled();
  });

  // Regression for issue #56: clips already on the sync module when the
  // plugin starts must not replay as motion events on the first read.
  it('baselines the first manifest read without firing motion', async () => {
    const { blink, api, log, poll, state } = makeHarness();
    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    expect(api.requestLocalStorageManifest).toHaveBeenCalledWith(100, 555);
    expect(api.getLocalStorageManifest).toHaveBeenCalledWith(100, 555, 777);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('manifest read (1 clips)')
    );

    // The entry is stored (thumbnails, later-read dedup) but carries no
    // discovery stamp, so it cannot trip the motion window.
    expect(blink.getLocalMediaTimestamp(42)).toBe(0);
    const entry = await blink.getCameraLastMotion(100, 42);
    expect(entry?.source).toBe('local_storage');
  });

  it('fires motion for a clip that appears after the baseline read', async () => {
    const { blink, api, poll, state } = makeHarness();
    const oldStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    api.getLocalStorageManifest.mockResolvedValue({
      manifest_id: 'm1',
      clips: [{ id: '1', camera_name: 'FrontDoor', created_at: oldStart }],
    });

    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();
    expect(blink.getLocalMediaTimestamp(42)).toBe(0);

    const newStart = new Date().toISOString();
    api.getLocalStorageManifest.mockResolvedValue({
      manifest_id: 'm2',
      clips: [
        { id: '1', camera_name: 'FrontDoor', created_at: oldStart },
        { id: '2', camera_name: 'FrontDoor', created_at: newStart },
      ],
    });
    const before = Date.now();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    expect(blink.getLocalMediaTimestamp(42)).toBeGreaterThanOrEqual(before);
    const entry = await blink.getCameraLastMotion(100, 42);
    expect(entry?.created_at).toBe(newStart);
  });

  it('baselines an empty first read so the next clip fires', async () => {
    const { blink, api, poll, state } = makeHarness();
    api.getLocalStorageManifest.mockResolvedValue({
      manifest_id: 'm1',
      clips: [],
    });

    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();
    expect(blink.getLocalMediaTimestamp(42)).toBe(0);

    api.getLocalStorageManifest.mockResolvedValue({
      manifest_id: 'm2',
      clips: [
        {
          id: '1',
          camera_name: 'FrontDoor',
          created_at: new Date().toISOString(),
        },
      ],
    });
    const before = Date.now();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    expect(blink.getLocalMediaTimestamp(42)).toBeGreaterThanOrEqual(before);
  });

  it('does not re-fire when a later read repeats the baseline clip', async () => {
    const { blink, api, poll, state } = makeHarness();
    const oldStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    api.getLocalStorageManifest.mockResolvedValue({
      manifest_id: 'm1',
      clips: [{ id: '1', camera_name: 'FrontDoor', created_at: oldStart }],
    });

    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    state()!.nextPollAt = 0;
    await poll();
    await flush();

    expect(blink.getLocalMediaTimestamp(42)).toBe(0);
  });

  it('treats a busy command timeout as a retryable failure', async () => {
    const { api, log, poll, state } = makeHarness();
    api.command.mockResolvedValue(undefined);
    api.requestLocalStorageManifest.mockResolvedValue({
      message: 'System is busy, please wait',
    });
    api.command.mockImplementation(async () => undefined);

    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('system busy, will retry')
    );
    expect(api.getLocalStorageManifest).not.toHaveBeenCalled();
    expect(state()!.backoff.attempt).toBe(1);
    expect(state()!.nextPollAt).toBeGreaterThan(Date.now());
  });

  it('rejects a busy body on the manifest fetch instead of treating it as empty', async () => {
    const { api, log, poll, state } = makeHarness();
    api.getLocalStorageManifest.mockResolvedValue({
      message: 'System is busy, please wait',
    });

    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('manifest fetch returned no data')
    );
    expect(state()!.backoff.attempt).toBe(1);
  });

  it('does not overlap manifest attempts', async () => {
    const { api, poll, state } = makeHarness();
    let release!: () => void;
    api.getLocalStorageManifest.mockReturnValue(
      new Promise<never>(resolve => {
        release = () => resolve({ manifest_id: 'm1', clips: [] } as never);
      })
    );

    await poll();
    state()!.nextPollAt = 0;
    await poll();
    state()!.nextPollAt = 0;
    await poll();
    release();
    await flush();

    expect(api.requestLocalStorageManifest).toHaveBeenCalledTimes(1);
  });

  it('stays idle in auto mode when cloud media exists', async () => {
    const { api, poll, state } = makeHarness();
    api.getMediaChange.mockResolvedValue({
      media: [{ id: 1, created_at: '2026-07-22T00:00:00Z' }],
    });

    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    expect(api.requestLocalStorageManifest).not.toHaveBeenCalled();
  });

  it('polls regardless of cloud media in always mode', async () => {
    const { api, poll, state } = makeHarness({ localStorageMotion: 'always' });
    api.getMediaChange.mockResolvedValue({
      media: [{ id: 1, created_at: '2026-07-22T00:00:00Z' }],
    });

    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    expect(api.requestLocalStorageManifest).toHaveBeenCalled();
  });

  it('does nothing in never mode', async () => {
    const { api, poll } = makeHarness({ localStorageMotion: 'never' });
    await poll();
    await flush();

    expect(api.getMediaChange).not.toHaveBeenCalled();
    expect(api.requestLocalStorageManifest).not.toHaveBeenCalled();
  });

  it('stamps discovery time so old recordings still count as fresh motion', async () => {
    const { blink, api, poll, state } = makeHarness();
    api.getLocalStorageManifest.mockResolvedValue({
      manifest_id: 'm1',
      clips: [],
    });
    await poll();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    // Post-baseline, a clip whose recording started long ago (issue #55:
    // recording length + manifest lag can exceed the decay window) is
    // stamped with its discovery time so it still fires.
    const oldStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    api.getLocalStorageManifest.mockResolvedValue({
      manifest_id: 'm2',
      clips: [{ id: '1', camera_name: 'FrontDoor', created_at: oldStart }],
    });
    const before = Date.now();
    state()!.nextPollAt = 0;
    await poll();
    await flush();

    // Discovery timestamp is now, even though the recording started long ago
    expect(blink.getLocalMediaTimestamp(42)).toBeGreaterThanOrEqual(before);
    // The synthesized entry keeps the true recording start time
    const entry = await blink.getCameraLastMotion(100, 42);
    expect(entry?.created_at).toBe(oldStart);
  });

  it('schedules the next poll on the regular cadence after success', async () => {
    const { poll, state } = makeHarness();
    await poll();
    state()!.nextPollAt = 0;
    const before = Date.now();
    await poll();
    await flush();

    const next = state()!.nextPollAt;
    expect(next).toBeGreaterThanOrEqual(before + LOCAL_STORAGE_POLL * 1000);
  });
});
