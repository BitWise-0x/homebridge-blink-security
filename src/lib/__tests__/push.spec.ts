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
  signOutPushSession,
  type ReceiverFactory,
} from '../push.js';
import {
  newSignInPending,
  type PushHttp,
  type PushSessionData,
} from '../pushAuth.js';
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
  it('parses a real Blink Video Doorbell press (ids changed)', () => {
    // As received on 2026-10-31 from a Video Doorbell on an account without
    // a subscription.
    const event = parseBlinkPush({
      message: {
        data: {
          message: 'Someone is at your Front Door',
          thumbnail_url: '',
          tier: 'e011',
          target_name: 'Front Door',
          vibrate: '1',
          camera: '92001',
          camera_name: 'Front Door',
          ring_device_id: '700000001',
          ring_event_id: '7700000000000000001',
          event_type: 'button_press',
          collapse_key: 'device#700000001#real_time#1793474949352',
          sound: '1',
          'pinpoint.campaign.campaign_id': '_DIRECT',
          unique_id: 'AbCdEfGhIjKlMnOp',
          target: 'doorbell',
          created_at: '2026-10-31T19:29:09+00:00',
          command: '0',
          category: 'media',
          return_receipt: 'true',
          network: '110001',
          video: '0',
          account_id: '100001',
          target_id: '92001',
        },
      },
      persistentId: '0:1',
    } as never);
    expect(event).toMatchObject({
      category: 'media',
      eventType: 'button_press',
      cameraId: 92001,
      networkId: 110001,
      cameraName: 'Front Door',
      createdAt: '2026-10-31T19:29:09+00:00',
      uniqueId: 'AbCdEfGhIjKlMnOp',
      returnReceipt: true,
    });
    expect(isDoorbellPress(event)).toBe(true);
  });

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

  it('does not fire again for the clip Blink stamps when the recording ends', async () => {
    // Seen live: push at T, cloud clip of the same press stamped T+16s.
    const pushedAt = Date.now();
    const { d, onPress } = doorbell(new Date(pushedAt + 16_000).toISOString());
    d.notifyPress(pushedAt);
    expect(await d.checkForPress()).toBe(false);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('still fires for a clip of a later, separate press', async () => {
    const pushedAt = Date.now();
    const { d, onPress } = doorbell(new Date(pushedAt + 45_000).toISOString());
    d.notifyPress(pushedAt);
    expect(await d.checkForPress()).toBe(true);
    expect(onPress).toHaveBeenCalledTimes(2);
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

  const session: PushSessionData = {
    hardwareId: 'HW',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
    tier: 'e006',
    accountId: 1234,
    clientId: '987',
  };

  function writeState(state: Record<string, unknown>) {
    fs.mkdirSync(path.join(dir, 'blink'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'blink', 'push.json'),
      JSON.stringify(state)
    );
  }

  function readState() {
    return JSON.parse(
      fs.readFileSync(path.join(dir, 'blink', 'push.json'), 'utf8')
    );
  }

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

  function fakeHttp(status = 200) {
    const calls: Array<{ method: string; url: string; json?: unknown }> = [];
    const http = vi.fn(
      async (req: { method: string; url: string; json?: unknown }) => {
        calls.push(req);
        return { status, data: {}, headers: {} };
      }
    );
    return { http: http as unknown as PushHttp, calls };
  }

  it('asks for a sign-in, with a link, when there is no push session', async () => {
    const { receiver } = fakeReceiver();
    const log = makeLog();
    const listener = new BlinkPushListener(log, dir, vi.fn(), {
      receiverFactory: (() => receiver) as unknown as ReceiverFactory,
      http: fakeHttp().http,
    });
    await listener.start();
    expect(receiver.connect).not.toHaveBeenCalled();
    const warning = String(vi.mocked(log.warn).mock.calls[0][0]);
    expect(warning).toContain(
      'https://api.oauth.blink.com/oauth/v2/authorize?'
    );
    expect(warning).toContain('client_id=android');
    expect(readState().pending.state).toBeTruthy();
  });

  it('keeps the same sign-in link across restarts until it is used', async () => {
    const make = () =>
      new BlinkPushListener(makeLog(), dir, vi.fn(), {
        receiverFactory: (() =>
          fakeReceiver().receiver) as unknown as ReceiverFactory,
        http: fakeHttp().http,
      });
    await make().start();
    const first = readState().pending.state;
    await make().start();
    expect(readState().pending.state).toBe(first);
  });

  it('finishes the sign-in from the callback address, then connects', async () => {
    const pending = newSignInPending();
    writeState({ pending });
    const { receiver } = fakeReceiver();
    const http = vi.fn(async (req: { url: string }) => {
      if (req.url.endsWith('/oauth/token')) {
        return {
          status: 200,
          data: { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
          headers: {},
        };
      }
      if (req.url.endsWith('/tier_info')) {
        return {
          status: 200,
          data: { tier: 'e006', account_id: 1234 },
          headers: {},
        };
      }
      if (req.url.endsWith('/homescreen')) {
        return { status: 200, data: {}, headers: { 'client-id': '555' } };
      }
      return { status: 200, data: {}, headers: {} };
    });
    const listener = new BlinkPushListener(makeLog(), dir, vi.fn(), {
      signInCallback: `https://applinks.blink.com/signin/callback?code=C0DE&state=${pending.state}`,
      receiverFactory: (() => receiver) as unknown as ReceiverFactory,
      http: http as unknown as PushHttp,
    });
    await listener.start();
    expect(listener.signedIn).toBe(true);
    expect(receiver.connect).toHaveBeenCalled();
    expect(http).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://rest-e006.immedia-semi.com/clients/555/update',
        json: expect.objectContaining({ notification_key: 'fcm-token' }),
      })
    );
    const saved = readState();
    expect(saved.pending).toBeUndefined();
    expect(saved.session.clientId).toBe('555');
    listener.stop();
  });

  it('finishes the sign-in when the callback is saved to config.json, without a restart', async () => {
    const configPath = path.join(dir, 'config.json');
    const writeConfig = (callback?: string) =>
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          platforms: [
            { platform: 'config' },
            { platform: 'BlinkSecurity', 'push-sign-in-callback': callback },
          ],
        })
      );
    writeConfig();
    const { receiver } = fakeReceiver();
    const http = vi.fn(async (req: { url: string }) => {
      if (req.url.endsWith('/oauth/token')) {
        return {
          status: 200,
          data: { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
          headers: {},
        };
      }
      if (req.url.endsWith('/tier_info')) {
        return {
          status: 200,
          data: { tier: 'e006', account_id: 1234 },
          headers: {},
        };
      }
      if (req.url.endsWith('/homescreen')) {
        return { status: 200, data: {}, headers: { 'client-id': '555' } };
      }
      return { status: 200, data: {}, headers: {} };
    });
    const log = makeLog();
    const listener = new BlinkPushListener(log, dir, vi.fn(), {
      configPath,
      configPollMs: 20,
      receiverFactory: (() => receiver) as unknown as ReceiverFactory,
      http: http as unknown as PushHttp,
    });
    await listener.start();
    expect(listener.signedIn).toBe(false);
    const { state } = readState().pending;

    // an address from some earlier link is left alone
    writeConfig(
      'https://applinks.blink.com/signin/callback?code=OLD&state=other'
    );
    await new Promise(r => setTimeout(r, 80));
    expect(listener.signedIn).toBe(false);

    writeConfig(
      `https://applinks.blink.com/signin/callback?code=C0DE&passkey_nudge=true&state=${state}`
    );
    await vi.waitFor(() => expect(receiver.connect).toHaveBeenCalled(), {
      timeout: 3000,
    });
    expect(listener.signedIn).toBe(true);
    expect(http).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.oauth.blink.com/oauth/token',
        form: expect.objectContaining({ code: 'C0DE' }),
      })
    );
    expect(log.info).toHaveBeenCalledWith('Blink push: signed in');
    expect(readState().pending).toBeUndefined();
    listener.stop();
  });

  it('retires the link and prints a new one when the saved code is refused', async () => {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ platforms: [] }));
    const http = vi.fn(async () => ({
      status: 401,
      data: { error: 'invalid_grant' },
      headers: {},
    }));
    const log = makeLog();
    const listener = new BlinkPushListener(log, dir, vi.fn(), {
      configPath,
      configPollMs: 20,
      receiverFactory: (() =>
        fakeReceiver().receiver) as unknown as ReceiverFactory,
      http: http as unknown as PushHttp,
    });
    await listener.start();
    const first = readState().pending.state;
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        platforms: [
          {
            platform: 'BlinkSecurity',
            'push-sign-in-callback': `https://applinks.blink.com/signin/callback?code=X&state=${first}`,
          },
        ],
      })
    );
    await vi.waitFor(() => expect(readState().pending.state).not.toBe(first), {
      timeout: 3000,
    });
    const warnings = vi.mocked(log.warn).mock.calls.map(c => String(c[0]));
    expect(warnings.some(w => w.includes('expired or was already used'))).toBe(
      true
    );
    expect(listener.signedIn).toBe(false);
    listener.stop();
  });

  it('registers the token with the new client after signing in again', async () => {
    writeState({ session });
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ platforms: [] }));
    const { receiver, handlers } = fakeReceiver();
    let mode: 'ok' | 'ended' = 'ok';
    const http = vi.fn(async (req: { url: string }) => {
      if (mode === 'ended') {
        return { status: 401, data: {}, headers: {} };
      }
      if (req.url.endsWith('/oauth/token')) {
        return {
          status: 200,
          data: { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
          headers: {},
        };
      }
      if (req.url.endsWith('/tier_info')) {
        return {
          status: 200,
          data: { tier: 'e006', account_id: 1234 },
          headers: {},
        };
      }
      if (req.url.endsWith('/homescreen')) {
        return { status: 200, data: {}, headers: { 'client-id': '555' } };
      }
      return { status: 200, data: {}, headers: {} };
    });
    const listener = new BlinkPushListener(makeLog(), dir, vi.fn(), {
      configPath,
      configPollMs: 20,
      receiverFactory: (() => receiver) as unknown as ReceiverFactory,
      http: http as unknown as PushHttp,
    });
    await listener.start();
    expect(listener.signedIn).toBe(true);

    // Blink ends the session while a rotated token is being registered.
    mode = 'ended';
    receiver.fcmToken = 'rotated';
    handlers.creds?.({ newCredentials: { fcm: { token: 'rotated' } } });
    await vi.waitFor(() => expect(listener.signedIn).toBe(false), {
      timeout: 3000,
    });

    mode = 'ok';
    receiver.fcmToken = 'fcm-token';
    const { state } = readState().pending;
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        platforms: [
          {
            platform: 'BlinkSecurity',
            'push-sign-in-callback': `https://applinks.blink.com/signin/callback?code=C0DE&state=${state}`,
          },
        ],
      })
    );
    await vi.waitFor(
      () =>
        expect(http).toHaveBeenCalledWith(
          expect.objectContaining({
            url: 'https://rest-e006.immedia-semi.com/clients/555/update',
          })
        ),
      { timeout: 3000 }
    );
    listener.stop();
  });

  it('repeats the sign-in link while the sign-in is still pending', async () => {
    vi.useFakeTimers();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ platforms: [] }));
    const log = makeLog();
    const listener = new BlinkPushListener(log, dir, vi.fn(), {
      configPath,
      receiverFactory: (() =>
        fakeReceiver().receiver) as unknown as ReceiverFactory,
      http: fakeHttp().http,
    });
    await listener.start();
    const reminders = () =>
      vi
        .mocked(log.warn)
        .mock.calls.filter(c => String(c[0]).includes('sign in once')).length;
    expect(reminders()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reminders()).toBe(1);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(reminders()).toBe(2);
    listener.stop();
  });

  it('ignores a callback address from another sign-in attempt', async () => {
    writeState({ pending: newSignInPending() });
    const { http } = fakeHttp();
    const log = makeLog();
    const listener = new BlinkPushListener(log, dir, vi.fn(), {
      signInCallback:
        'https://applinks.blink.com/signin/callback?code=C0DE&state=someone-else',
      receiverFactory: (() =>
        fakeReceiver().receiver) as unknown as ReceiverFactory,
      http,
    });
    await listener.start();
    expect(listener.signedIn).toBe(false);
    expect(http).not.toHaveBeenCalled();
  });

  it('registers the token with the push session client', async () => {
    writeState({ session });
    const { receiver } = fakeReceiver();
    const { http, calls } = fakeHttp();
    const listener = new BlinkPushListener(makeLog(), dir, vi.fn(), {
      receiverFactory: (() => receiver) as unknown as ReceiverFactory,
      http,
    });
    await listener.start();
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        url: 'https://rest-e006.immedia-semi.com/clients/987/update',
        json: expect.objectContaining({
          notification_key: 'fcm-token',
          client_name: PUSH_CLIENT_NAME,
        }),
      })
    );
    listener.stop();
    expect(receiver.destroy).toHaveBeenCalled();
  });

  it('persists push credentials and reuses them on the next start', async () => {
    writeState({ session });
    const first = fakeReceiver();
    const configs: unknown[] = [];
    const factory = ((config: unknown) => {
      configs.push(config);
      return first.receiver;
    }) as unknown as ReceiverFactory;
    const opts = { receiverFactory: factory, http: fakeHttp().http };
    const listener = new BlinkPushListener(makeLog(), dir, vi.fn(), opts);
    await listener.start();
    first.handlers.creds?.({ newCredentials: { fcm: { token: 'fcm-token' } } });
    listener.stop();

    const again = new BlinkPushListener(makeLog(), dir, vi.fn(), opts);
    await again.start();
    expect(configs[1]).toMatchObject({
      credentials: { fcm: { token: 'fcm-token' } },
    });
    again.stop();
  });

  it('delivers parsed events, records ids and sends requested receipts', async () => {
    writeState({ session });
    const { receiver, handlers } = fakeReceiver();
    const { http, calls } = fakeHttp();
    const onEvent = vi.fn();
    const listener = new BlinkPushListener(makeLog(), dir, onEvent, {
      receiverFactory: (() => receiver) as unknown as ReceiverFactory,
      http,
    });
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
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: 'https://rest-e006.immedia-semi.com/api/v2/notification',
        json: { transaction_id: 'tx-9', status: 'RECEIVED' },
      })
    );
    expect(readState().persistentIds).toEqual(['persist-1']);
    listener.stop();
  });

  it('asks for a new sign-in when Blink ends the push session', async () => {
    writeState({ session: { ...session, expiresAt: 0 } });
    const { http } = fakeHttp(401);
    const log = makeLog();
    const listener = new BlinkPushListener(log, dir, vi.fn(), {
      receiverFactory: (() =>
        fakeReceiver().receiver) as unknown as ReceiverFactory,
      http,
    });
    await listener.start();
    expect(listener.signedIn).toBe(false);
    expect(String(vi.mocked(log.warn).mock.calls.at(-1)?.[0])).toContain(
      'Blink push: sign in once'
    );
  });

  it('retries with backoff when the first connection fails', async () => {
    vi.useFakeTimers();
    writeState({ session });
    const failing = fakeReceiver();
    failing.receiver.connect.mockRejectedValueOnce(new Error('offline'));
    const { http, calls } = fakeHttp();
    const log = makeLog();
    const listener = new BlinkPushListener(log, dir, vi.fn(), {
      receiverFactory: (() => failing.receiver) as unknown as ReceiverFactory,
      http,
    });
    await listener.start();
    expect(log.warn).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter(c => c.url.endsWith('/update'))).toHaveLength(1);
    listener.stop();
  });

  it('does not register the token when stopped while connecting', async () => {
    writeState({ session, credentials: { fcm: { token: 'fcm-token' } } });
    const { receiver } = fakeReceiver();
    let finishConnect = () => {};
    receiver.connect.mockReturnValueOnce(
      new Promise<void>(resolve => (finishConnect = resolve))
    );
    const { http, calls } = fakeHttp();
    const log = makeLog();
    const listener = new BlinkPushListener(log, dir, vi.fn(), {
      receiverFactory: (() => receiver) as unknown as ReceiverFactory,
      http,
    });
    const started = listener.start();
    await vi.waitFor(() => expect(receiver.connect).toHaveBeenCalled());
    listener.stop();
    finishConnect();
    await started;
    expect(receiver.destroy).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(log.info).not.toHaveBeenCalledWith(
      'Blink push notifications connected'
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('signOutPushSession', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-push-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stateFile = () => path.join(dir, 'blink', 'push.json');

  function writeSession() {
    fs.mkdirSync(path.join(dir, 'blink'), { recursive: true });
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({
        session: {
          hardwareId: 'HW',
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3_600_000,
          tier: 'e006',
          accountId: 1234,
          clientId: '987',
        },
      })
    );
  }

  it('does nothing when push notifications were never set up', async () => {
    const http = vi.fn();
    await signOutPushSession(makeLog(), dir, http as unknown as PushHttp);
    expect(http).not.toHaveBeenCalled();
  });

  it('signs the push client out and forgets the session', async () => {
    writeSession();
    const http = vi.fn(async () => ({ status: 200, data: {}, headers: {} }));
    await signOutPushSession(makeLog(), dir, http as unknown as PushHttp);
    expect(http).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://rest-e006.immedia-semi.com/api/v4/account/1234/client/987/logout',
        headers: { Authorization: 'Bearer access', 'Client-Id': '987' },
      })
    );
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('forgets the session and says so when the sign-out fails', async () => {
    writeSession();
    const http = vi.fn(async () => ({ status: 500, data: {}, headers: {} }));
    const log = makeLog();
    await signOutPushSession(log, dir, http as unknown as PushHttp);
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain(
      'sign-out failed'
    );
    expect(fs.existsSync(stateFile())).toBe(false);
  });
});
