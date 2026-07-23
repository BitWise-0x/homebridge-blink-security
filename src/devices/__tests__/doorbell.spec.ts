import { describe, it, expect, vi } from 'vitest';
import { BlinkDoorbell } from '../doorbell.js';
import { LOCAL_STORAGE_SOURCE } from '../localStorage.js';
import type { HomescreenCamera } from '../base.js';
import { Blink } from '../index.js';
import { DEFAULT_OPTIONS } from '../../lib/config.js';
import type { BlinkAuthClient } from '../../lib/auth.js';
import type { Logger } from 'homebridge';
import type { MediaEntry } from '../../lib/api.js';

function makeDoorbell(lastMotion: Partial<MediaEntry> | undefined): {
  doorbell: BlinkDoorbell;
  onPress: ReturnType<typeof vi.fn>;
} {
  const data: HomescreenCamera = {
    id: 42,
    network_id: 100,
    name: 'Front Door',
    serial: 'TEST0042',
    fw_version: '1.0.0',
    type: 'lotus',
    enabled: true,
    thumbnail: '',
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  // Mirrors getCameraLastPress: a sourceless entry counts as a press, any
  // other known source does not.
  const isPress =
    lastMotion !== undefined &&
    (!lastMotion.source ||
      ['button', 'button_press'].includes(lastMotion.source));
  const blink = {
    getCameraLastMotion: vi.fn().mockResolvedValue(lastMotion),
    getCameraLastPress: vi
      .fn()
      .mockResolvedValue(isPress ? lastMotion : undefined),
  } as unknown as Blink;
  const doorbell = new BlinkDoorbell(data, blink);
  const onPress = vi.fn();
  doorbell.onPress = onPress;
  return { doorbell, onPress };
}

/**
 * Drives the REAL Blink.getCameraLastPress against a stubbed API, so the
 * selection logic under test is the shipped one rather than a mock of it.
 */
function makeDoorbellWithMedia(entries: Partial<MediaEntry>[]): {
  doorbell: BlinkDoorbell;
  onPress: ReturnType<typeof vi.fn>;
} {
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
    { ...DEFAULT_OPTIONS }
  );
  Object.defineProperty(blink, 'api', {
    value: {
      getMediaChange: vi.fn().mockResolvedValue({
        media: entries.map(e => ({
          id: 1,
          updated_at: e.created_at,
          device_id: 42,
          network_id: 100,
          device: 'lotus',
          thumbnail: '',
          ...e,
        })),
      }),
    },
  });
  const data: HomescreenCamera = {
    id: 42,
    network_id: 100,
    name: 'Front Door',
    serial: 'TEST0042',
    fw_version: '1.0.0',
    type: 'lotus',
    enabled: true,
    thumbnail: '',
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  const doorbell = new BlinkDoorbell(data, blink);
  const onPress = vi.fn();
  doorbell.onPress = onPress;
  return { doorbell, onPress };
}

describe('BlinkDoorbell.checkForPress source filtering', () => {
  // A fresh event strictly newer than the construction-time watermark.
  const freshCreatedAt = () => new Date(Date.now() + 1000).toISOString();

  it('fires for a button_press event', async () => {
    const { doorbell, onPress } = makeDoorbell({
      source: 'button_press',
      created_at: freshCreatedAt(),
    });
    await expect(doorbell.checkForPress()).resolves.toBe(true);
    expect(onPress).toHaveBeenCalledOnce();
  });

  // Local-storage manifest clips carry no source information, so they are
  // synthesized with source "local_storage" and must never register as a
  // doorbell button press — only as motion.
  it('ignores a local_storage event', async () => {
    const { doorbell, onPress } = makeDoorbell({
      source: LOCAL_STORAGE_SOURCE,
      created_at: freshCreatedAt(),
    });
    await expect(doorbell.checkForPress()).resolves.toBe(false);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('ignores a pir motion event', async () => {
    const { doorbell, onPress } = makeDoorbell({
      source: 'pir',
      created_at: freshCreatedAt(),
    });
    await expect(doorbell.checkForPress()).resolves.toBe(false);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('returns false when there is no media at all', async () => {
    const { doorbell, onPress } = makeDoorbell(undefined);
    await expect(doorbell.checkForPress()).resolves.toBe(false);
    expect(onPress).not.toHaveBeenCalled();
  });

  // Older Blink firmware omits the source field on doorbell media; those
  // entries must still register as presses.
  it('fires for an entry with no source field', async () => {
    const { doorbell, onPress } = makeDoorbell({
      created_at: freshCreatedAt(),
    });
    await expect(doorbell.checkForPress()).resolves.toBe(true);
    expect(onPress).toHaveBeenCalledOnce();
  });

  // getCameraLastMotion merges cloud media with local-storage clips and
  // returns only the newest. A local clip of the same doorbell event is
  // often stamped a moment later than the cloud button_press, so filtering
  // on the winner alone would silently swallow the real press.
  it('still fires when a newer local clip outranks the press', async () => {
    const press = freshCreatedAt();
    const { doorbell, onPress } = makeDoorbellWithMedia([
      {
        source: LOCAL_STORAGE_SOURCE,
        created_at: new Date(Date.parse(press) + 1000).toISOString(),
      },
      { source: 'button_press', created_at: press },
    ]);
    await expect(doorbell.checkForPress()).resolves.toBe(true);
    expect(onPress).toHaveBeenCalledOnce();
  });
});
