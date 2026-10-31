import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'homebridge';

import {
  BlinkPushListener,
  PUSH_CLIENT_NAME,
  flattenPushData,
  isDoorbellPress,
  parseBlinkPush,
  type ReceiverFactory,
} from '../push.js';
import type { BlinkApi } from '../api.js';
import { Blink } from '../../devices/index.js';
import { BlinkDoorbell } from '../../devices/doorbell.js';
import { DEFAULT_OPTIONS } from '../config.js';
import type { BlinkAuthClient } from '../auth.js';
import type { HomescreenCamera } from '../../devices/base.js';

function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function envelope(data: Record<string, unknown>, persistentId = 'p1') {
  return { message: { data }, persistentId };
}

describe('flattenPushData', () => {
  it('reads Blink fields at the top level', () => {
    expect(
      flattenPushData({ category: 'media', event_type: 'button_press' })
    ).toEqual({ category: 'media', event_type: 'button_press' });
  });

  it('unwraps JSON nested as a string under data/payload/message', () => {
    const nested = {
      data: {
        payload: JSON.stringify({
          category: 'media',
          event_type: 'button_press',
          camera_id: 42,
        }),
      },
    };
    expect(flattenPushData(nested)).toMatchObject({
      category: 'media',
      event_type: 'button_press',
      camera_id: 42,
    });
  });

  it('keeps a plain string field that is not JSON', () => {
    expect(flattenPushData({ message: 'Someone is at the door' })).toEqual({
      message: 'Someone is at the door',
    });
  });

  it('ignores garbage', () => {
    expect(flattenPushData('not json')).toEqual({});
    expect(flattenPushData(null)).toEqual({});
    expect(flattenPushData([1, 2])).toEqual({});
  });
});

describe('parseBlinkPush', () => {
  it('parses a doorbell press with string ids and a receipt request', () => {
    const event = parseBlinkPush(
      envelope({
        category: 'media',
        event_type: 'button_press',
        camera_id: '42',
        network_id: '100',
        camera_name: 'Front Door',
        created_at: '2026-10-31T17:50:00+00:00',
        unique_id: 'tx-1',
        return_receipt: 'true',
      })
    );
    expect(event).toMatchObject({
      category: 'media',
      eventType: 'button_press',
      cameraId: 42,
      networkId: 100,
      cameraName: 'Front Door',
      uniqueId: 'tx-1',
      returnReceipt: true,
    });
    expect(isDoorbellPress(event)).toBe(true);
  });

  it('does not treat doorbell motion as a press', () => {
    const event = parseBlinkPush(
      envelope({ category: 'media', event_type: 'pir', camera_id: 42 })
    );
    expect(isDoorbellPress(event)).toBe(false);
  });
});

describe('BlinkDoorbell.notifyPress', () => {
  function doorbell(cloudPress?: string) {
    const data: HomescreenCamera = {
      id: 42,
      network_id: 100,
      name: 'Front Door',
      serial: 'X',
      fw_version: '1',
      type: 'lotus',
      enabled: true,
      thumbnail: '',
      status: 'online',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const blink = {
      getCameraLastPress: vi
        .fn()
        .mockResolvedValue(
          cloudPress ? { created_at: cloudPress, device_id: 42 } : undefined
        ),
    } as unknown as Blink;
    const d = new BlinkDoorbell(data, blink);
    const onPress = vi.fn();
    d.onPress = onPress;
    return { d, onPress };
  }

  it('fires for a fresh press, even one Blink stamps slightly in the past', () => {
    const { d, onPress } = doorbell();
    expect(d.notifyPress(Date.now() - 3000)).toBe(true);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(d.doorbellPressed).toBe(true);
  });

  it('fires for a second, separate press', () => {
    const { d, onPress } = doorbell();
    d.notifyPress(Date.now());
    expect(d.notifyPress(Date.now())).toBe(true);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('does not fire again when polling later finds the same press as a clip', async () => {
    const pressedAt = new Date(Date.now() - 2000).toISOString();
    const { d, onPress } = doorbell(pressedAt);
    d.notifyPress(Date.parse(pressedAt));
    expect(await d.checkForPress()).toBe(false);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not fire again for the clip when Blink's clock runs ahead", async () => {
    const pressedAt = new Date(Date.now() + 20_000).toISOString();
    const { d, onPress } = doorbell(pressedAt);
    d.notifyPress(Date.parse(pressedAt));
    expect(await d.checkForPress()).toBe(false);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale press', () => {
    const { d, onPress } = doorbell();
    expect(d.notifyPress(Date.now() - 10 * 60_000)).toBe(false);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('Blink.handlePushEvent', () => {
  function blinkWith(doorbells: Array<{ id: number; name: string }>) {
    const log = makeLog();
    const blink = new Blink(
      { isAuthenticated: false } as unknown as BlinkAuthClient,
      log,
      30,
      15,
      3600,
      { ...DEFAULT_OPTIONS }
    );
    const presses: number[] = [];
    for (const { id, name } of doorbells) {
      const d = new BlinkDoorbell(
        {
          id,
          network_id: 100,
          name,
          serial: 'X',
          fw_version: '1',
          type: 'lotus',
          enabled: true,
          thumbnail: '',
          status: 'online',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        blink
      );
      d.onPress = () => presses.push(id);
      blink.doorbells.set(id, d);
    }
    return { blink, presses, log };
  }

  const press = (fields: Record<string, unknown>) =>
    parseBlinkPush(
      envelope({ category: 'media', event_type: 'button_press', ...fields })
    );

  it('routes by camera id', () => {
    const { blink, presses } = blinkWith([
      { id: 1, name: 'Front' },
      { id: 2, name: 'Back' },
    ]);
    blink.handlePushEvent(press({ camera_id: 2 }));
    expect(presses).toEqual([2]);
  });

  it('routes by camera name when no id is sent', () => {
    const { blink, presses } = blinkWith([
      { id: 1, name: 'Front' },
      { id: 2, name: 'Back' },
    ]);
    blink.handlePushEvent(press({ camera_name: 'back' }));
    expect(presses).toEqual([2]);
  });

  it('falls back to the only doorbell when nothing identifies it', () => {
    const { blink, presses } = blinkWith([{ id: 7, name: 'Front Door' }]);
    blink.handlePushEvent(press({}));
    expect(presses).toEqual([7]);
  });

  it('warns rather than guessing between several doorbells', () => {
    const { blink, presses, log } = blinkWith([
      { id: 1, name: 'Front' },
      { id: 2, name: 'Back' },
    ]);
    blink.handlePushEvent(press({ camera_name: 'Garage' }));
    expect(presses).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('ignores pushes that are not presses', () => {
    const { blink, presses } = blinkWith([{ id: 7, name: 'Front Door' }]);
    blink.handlePushEvent(
      parseBlinkPush(
        envelope({ category: 'motion', event_type: 'cloud_motion' })
      )
    );
    expect(presses).toEqual([]);
  });
});

describe('BlinkPushListener', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-push-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function fakeReceiver(token = 'fcm-token') {
    const handlers: {
      creds?: (d: { newCredentials: unknown }) => void;
      note?: (e: unknown) => void;
    } = {};
    const receiver = {
      fcmToken: token,
      persistentIds: [] as string[],
      onCredentialsChanged: vi.fn(cb => (handlers.creds = cb)),
      onNotification: vi.fn(cb => (handlers.note = cb)),
      connect: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };
    return { receiver, handlers };
  }

  function fakeApi() {
    return {
      getClientId: vi.fn().mockResolvedValue('987'),
      updateClientNotificationKey: vi.fn().mockResolvedValue(undefined),
      sendNotificationReceipt: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('connects, then registers the token with this session client', async () => {
    const { receiver } = fakeReceiver();
    const api = fakeApi();
    const factory = vi.fn(() => receiver) as unknown as ReceiverFactory;
    const listener = new BlinkPushListener(
      api as unknown as BlinkApi,
      makeLog(),
      dir,
      vi.fn(),
      factory
    );
    await listener.start();
    expect(receiver.connect).toHaveBeenCalled();
    expect(api.updateClientNotificationKey).toHaveBeenCalledWith(
      '987',
      'fcm-token',
      PUSH_CLIENT_NAME
    );
    listener.stop();
    expect(receiver.destroy).toHaveBeenCalled();
  });

  it('persists credentials and reuses them on the next start', async () => {
    const first = fakeReceiver();
    const api = fakeApi();
    const configs: unknown[] = [];
    const factory = ((config: unknown) => {
      configs.push(config);
      return first.receiver;
    }) as unknown as ReceiverFactory;
    const listener = new BlinkPushListener(
      api as unknown as BlinkApi,
      makeLog(),
      dir,
      vi.fn(),
      factory
    );
    await listener.start();
    first.handlers.creds?.({ newCredentials: { fcm: { token: 'fcm-token' } } });
    listener.stop();

    const again = new BlinkPushListener(
      api as unknown as BlinkApi,
      makeLog(),
      dir,
      vi.fn(),
      factory
    );
    await again.start();
    expect(configs[1]).toMatchObject({
      credentials: { fcm: { token: 'fcm-token' } },
    });
    again.stop();
  });

  it('delivers parsed events, records ids and sends requested receipts', async () => {
    const { receiver, handlers } = fakeReceiver();
    const api = fakeApi();
    const onEvent = vi.fn();
    const listener = new BlinkPushListener(
      api as unknown as BlinkApi,
      makeLog(),
      dir,
      onEvent,
      (() => receiver) as unknown as ReceiverFactory
    );
    await listener.start();
    handlers.note?.(
      envelope(
        {
          category: 'media',
          event_type: 'button_press',
          unique_id: 'tx-9',
          return_receipt: true,
        },
        'persist-1'
      )
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'button_press' })
    );
    expect(api.sendNotificationReceipt).toHaveBeenCalledWith('tx-9');
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, 'blink', 'push.json'), 'utf8')
    );
    expect(saved.persistentIds).toEqual(['persist-1']);
    listener.stop();
  });

  it('retries with backoff when the first connection fails', async () => {
    vi.useFakeTimers();
    const failing = fakeReceiver();
    failing.receiver.connect.mockRejectedValueOnce(new Error('offline'));
    const api = fakeApi();
    const factory = vi.fn(() => failing.receiver) as unknown as ReceiverFactory;
    const log = makeLog();
    const listener = new BlinkPushListener(
      api as unknown as BlinkApi,
      log,
      dir,
      vi.fn(),
      factory
    );
    await listener.start();
    expect(log.warn).toHaveBeenCalled();
    expect(api.updateClientNotificationKey).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.updateClientNotificationKey).toHaveBeenCalledTimes(1);
    listener.stop();
  });
});
