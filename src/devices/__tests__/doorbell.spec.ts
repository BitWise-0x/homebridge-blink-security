import { describe, it, expect, vi } from 'vitest';
import { BlinkDoorbell } from '../doorbell.js';
import { LOCAL_STORAGE_SOURCE } from '../localStorage.js';
import type { HomescreenCamera } from '../base.js';
import type { Blink } from '../index.js';
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
  const blink = {
    getCameraLastMotion: vi.fn().mockResolvedValue(lastMotion),
  } as unknown as Blink;
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
});
