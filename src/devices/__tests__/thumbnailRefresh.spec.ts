import { describe, it, expect, vi } from 'vitest';
import { Blink, THUMBNAIL_RETRY } from '../index.js';
import { DEFAULT_OPTIONS } from '../../lib/config.js';
import type { BlinkAuthClient } from '../../lib/auth.js';
import type { Logger } from 'homebridge';

const SNAPSHOT_RATE = 3600;

function thumbnailUrl(ageSeconds: number): string {
  const ts = Math.floor(Date.now() / 1000) - ageSeconds;
  return `/api/v3/media/accounts/1/networks/100/catalina/42/thumbnail/thumbnail.jpg?ts=${ts}&ext=`;
}

function makeDevice(
  type: string,
  overrides: { enabled?: boolean; thumbnailAge?: number } = {}
) {
  return {
    id: 42,
    network_id: 100,
    name: 'Patio',
    serial: 'TEST0042',
    fw_version: '1.0.0',
    type,
    enabled: overrides.enabled ?? true,
    thumbnail: thumbnailUrl(overrides.thumbnailAge ?? SNAPSHOT_RATE * 2),
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

async function makeBlink(
  armed: boolean,
  devices: { cameras?: unknown[]; doorbells?: unknown[] }
) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const blink = new Blink(
    { isAuthenticated: false } as unknown as BlinkAuthClient,
    log,
    30,
    15,
    SNAPSHOT_RATE,
    { ...DEFAULT_OPTIONS, localStorageMotion: 'never' }
  );
  const homescreen = {
    networks: [{ id: 100, name: 'Blink Home', armed }],
    sync_modules: [{ id: 555, network_id: 100, status: 'online' }],
    cameras: devices.cameras ?? [],
    owls: [],
    doorbells: devices.doorbells ?? [],
    doorbell_buttons: [],
    sirens: [],
  };
  // A fresh copy per fetch, as the real API returns: anything the plugin
  // writes into device data must not survive a poll.
  const api = {
    getAccountHomescreen: vi.fn(async () => structuredClone(homescreen)),
    getMediaChange: vi.fn().mockResolvedValue({ media: [] }),
    probeDoorbellConfig: vi.fn().mockResolvedValue(undefined),
    lock: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
    command: vi.fn((_networkID: number, fn: () => Promise<unknown>) => fn()),
    updateCameraThumbnail: vi.fn().mockResolvedValue({}),
    updateOwlThumbnail: vi.fn().mockResolvedValue({}),
    updateDoorbellThumbnail: vi.fn().mockResolvedValue({}),
  };
  Object.defineProperty(blink, 'api', { value: api });
  await blink.refreshData();
  return { blink, api };
}

describe('Blink.refreshCameraThumbnail scheduled refresh', () => {
  // Regression for issue #84: the scheduled refresh also required the
  // network to be armed, so a disarmed system never refreshed thumbnails
  // even though the documented contract is "refresh when the camera is
  // enabled". Hiding thumbnails while disarmed is privacy mode's job.
  it('refreshes an enabled camera while the system is disarmed', async () => {
    const { blink, api } = await makeBlink(false, {
      cameras: [makeDevice('catalina')],
    });
    await blink.refreshCameraThumbnail(100, 42);
    expect(api.updateCameraThumbnail).toHaveBeenCalledOnce();
  });

  it('refreshes an enabled camera while the system is armed', async () => {
    const { blink, api } = await makeBlink(true, {
      cameras: [makeDevice('catalina')],
    });
    await blink.refreshCameraThumbnail(100, 42);
    expect(api.updateCameraThumbnail).toHaveBeenCalledOnce();
  });

  it('does not refresh a camera with motion detection disabled', async () => {
    const { blink, api } = await makeBlink(true, {
      cameras: [makeDevice('catalina', { enabled: false })],
    });
    await blink.refreshCameraThumbnail(100, 42);
    expect(api.updateCameraThumbnail).not.toHaveBeenCalled();
  });

  it('does not refresh before the interval has elapsed', async () => {
    const { blink, api } = await makeBlink(false, {
      cameras: [makeDevice('catalina', { thumbnailAge: 60 })],
    });
    await blink.refreshCameraThumbnail(100, 42);
    expect(api.updateCameraThumbnail).not.toHaveBeenCalled();
  });

  // A failed capture leaves the thumbnail URL's `ts` unchanged, and the poll
  // that follows replaces device data, so the attempt time must be kept
  // elsewhere or the command is re-sent on every HomeKit snapshot request.
  it('does not re-send a failed capture before the interval has elapsed', async () => {
    const { blink, api } = await makeBlink(false, {
      cameras: [makeDevice('catalina')],
    });
    api.command.mockResolvedValue(undefined);
    await blink.refreshCameraThumbnail(100, 42);
    await blink.refreshCameraThumbnail(100, 42);
    expect(api.command).toHaveBeenCalledOnce();
  });

  // ...but one transient failure must not hold off the next attempt for a
  // whole TTL either.
  it('retries a failed capture once the retry window has passed', async () => {
    const { blink, api } = await makeBlink(false, {
      cameras: [makeDevice('catalina')],
    });
    api.command.mockResolvedValue(undefined);
    await blink.refreshCameraThumbnail(100, 42);
    blink.cameras.get(42)!.lastThumbnailRequest -= THUMBNAIL_RETRY * 1000;
    await blink.refreshCameraThumbnail(100, 42);
    expect(api.command).toHaveBeenCalledTimes(2);
  });
});

describe('Blink.refreshDoorbellThumbnail scheduled refresh', () => {
  it('refreshes an enabled doorbell while the system is disarmed', async () => {
    const { blink, api } = await makeBlink(false, {
      doorbells: [makeDevice('lotus')],
    });
    await blink.refreshDoorbellThumbnail(100, 42);
    expect(api.updateDoorbellThumbnail).toHaveBeenCalledOnce();
  });

  it('does not re-send a failed doorbell capture before the interval has elapsed', async () => {
    const { blink, api } = await makeBlink(false, {
      doorbells: [makeDevice('lotus')],
    });
    api.command.mockResolvedValue(undefined);
    await blink.refreshDoorbellThumbnail(100, 42);
    await blink.refreshDoorbellThumbnail(100, 42);
    expect(api.command).toHaveBeenCalledOnce();
  });

  it('does not refresh a doorbell with motion detection disabled', async () => {
    const { blink, api } = await makeBlink(false, {
      doorbells: [makeDevice('lotus', { enabled: false })],
    });
    await blink.refreshDoorbellThumbnail(100, 42);
    expect(api.updateDoorbellThumbnail).not.toHaveBeenCalled();
  });
});
