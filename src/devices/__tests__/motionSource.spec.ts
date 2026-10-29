import { describe, it, expect, vi } from 'vitest';
import { Blink } from '../index.js';
import { DEFAULT_OPTIONS } from '../../lib/config.js';
import type { BlinkAuthClient } from '../../lib/auth.js';
import type { MediaEntry } from '../../lib/api.js';
import type { Logger } from 'homebridge';

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

function mediaEntry(entry: Partial<MediaEntry>): MediaEntry {
  return {
    id: 1,
    created_at: secondsAgo(5),
    updated_at: secondsAgo(5),
    device_id: 42,
    network_id: 100,
    device: 'camera',
    thumbnail: '/media/thumb.jpg',
    ...entry,
  };
}

function makeDevice(type: string) {
  return {
    id: 42,
    network_id: 100,
    name: 'Patio',
    serial: 'TEST0042',
    fw_version: '1.0.0',
    type,
    enabled: true,
    thumbnail: '',
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * Drives the REAL motion selection (getMergedMedia + getCameraLastMotion +
 * BlinkCamera.getMotionDetected) against a stubbed API on an armed network.
 */
async function makeArmedBlink(
  media: MediaEntry[],
  devices: { cameras?: unknown[]; doorbells?: unknown[] } = {
    cameras: [makeDevice('catalina')],
  }
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
    3600,
    { ...DEFAULT_OPTIONS, localStorageMotion: 'never' }
  );
  const homescreen = {
    networks: [{ id: 100, name: 'Blink Home', armed: true }],
    sync_modules: [{ id: 555, network_id: 100, status: 'online' }],
    cameras: devices.cameras ?? [],
    owls: [],
    doorbells: devices.doorbells ?? [],
    doorbell_buttons: [],
    sirens: [],
  };
  const api = {
    getAccountHomescreen: vi.fn(async () => structuredClone(homescreen)),
    getMediaChange: vi.fn(async () => ({ media: structuredClone(media) })),
    probeDoorbellConfig: vi.fn().mockResolvedValue(undefined),
    lock: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
    command: vi.fn((_networkID: number, fn: () => Promise<unknown>) => fn()),
  };
  Object.defineProperty(blink, 'api', { value: api });
  await blink.refreshData();
  // Armed well before any of the clips below.
  blink.networks.get(100)!.armedAt = Date.now() - 60 * 60 * 1000;
  return blink;
}

describe('motion selection ignores non-motion media sources', () => {
  // Blink's Photo Capture feature periodically posts a summary clip of the
  // camera's scheduled snapshots. Its media entry has source "snapshot"; it
  // is not a motion event and must not trip motion (and with it the alarm).
  it('does not fire when the newest entry is a snapshot summary', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ source: 'snapshot', created_at: secondsAgo(5) }),
    ]);
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      false
    );
    await expect(blink.getCameraLastMotion(100, 42)).resolves.toBeUndefined();
  });

  // The filter must pick the newest MOTION entry, not just bail out when
  // the newest entry is a snapshot: a snapshot posted moments after a real
  // motion clip must not hide that clip.
  it('still fires for a motion clip that is older than a newer snapshot', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ id: 2, source: 'snapshot', created_at: secondsAgo(5) }),
      mediaEntry({ id: 1, source: 'pir', created_at: secondsAgo(20) }),
    ]);
    const entry = await blink.getCameraLastMotion(100, 42);
    expect(entry?.id).toBe(1);
    expect(entry?.source).toBe('pir');
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      true
    );
  });

  it('still fires for a plain motion clip', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ source: 'pir', created_at: secondsAgo(5) }),
    ]);
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      true
    );
  });

  // Older firmware omits the source field; such entries stay motion.
  it('still fires for a clip with no source field', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({ created_at: secondsAgo(5) }),
    ]);
    await expect(blink.cameras.get(42)!.getMotionDetected()).resolves.toBe(
      true
    );
  });

  // Thumbnails still use the newest media of any kind: a snapshot entry's
  // thumbnail is a genuinely fresh image of the camera.
  it('still offers a snapshot entry as the newest thumbnail', async () => {
    const blink = await makeArmedBlink([
      mediaEntry({
        source: 'snapshot',
        created_at: secondsAgo(5),
        thumbnail: '/media/snapshot-summary.jpg',
      }),
    ]);
    const camera = blink.cameras.get(42)!;
    camera.data = { ...camera.data, updated_at: new Date().toISOString() };
    camera.thumbnailCreatedAt = Date.now() - 60 * 60 * 1000;
    await expect(blink.getCameraLastThumbnail(100, 42)).resolves.toBe(
      '/media/snapshot-summary.jpg'
    );
  });

  it('leaves doorbell press detection unaffected by a newer snapshot', async () => {
    const press = new Date(Date.now() - 2000).toISOString();
    const blink = await makeArmedBlink(
      [
        mediaEntry({
          id: 2,
          device: 'lotus',
          source: 'snapshot',
          created_at: secondsAgo(1),
        }),
        mediaEntry({
          id: 1,
          device: 'lotus',
          source: 'button_press',
          created_at: press,
        }),
      ],
      { doorbells: [makeDevice('lotus')] }
    );
    const pressEntry = await blink.getCameraLastPress(100, 42);
    expect(pressEntry?.id).toBe(1);

    const doorbell = blink.doorbells.get(42)!;
    doorbell.lastDoorbellPress = Date.now() - 60 * 1000;
    const onPress = vi.fn();
    doorbell.onPress = onPress;
    await expect(doorbell.checkForPress()).resolves.toBe(true);
    expect(onPress).toHaveBeenCalledOnce();
  });
});
