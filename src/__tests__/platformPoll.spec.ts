import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlinkSecurityPlatform } from '../platform.js';
import type { API, Logger, PlatformConfig } from 'homebridge';

/**
 * The poll loop re-arms itself with setTimeout after each cycle, so anything
 * that stalls a cycle stops polling entirely until it unblocks. A hung
 * media/changed request did exactly that: refreshData awaits it through
 * pollLocalStorage, so the homescreen poll went silent for the full 30s
 * axios timeout.
 */
function makeApi(): API {
  return {
    hap: {
      uuid: { generate: (s: string) => `uuid-${s}` },
      Characteristic: new Proxy({}, { get: () => 'characteristic' }),
      Service: new Proxy({}, { get: () => 'service' }),
    },
    platformAccessory: class {},
    user: { storagePath: () => '/tmp/blink-test' },
    on: () => {},
    registerPlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  } as unknown as API;
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

type PollInternals = {
  poll: () => Promise<void>;
  pollTimer?: ReturnType<typeof setTimeout>;
  blink: unknown;
  pushUpdates: () => void;
  syncAccessories: () => void;
};

describe('BlinkSecurityPlatform poll loop', () => {
  let platform: BlinkSecurityPlatform;
  let internals: PollInternals;

  beforeEach(() => {
    vi.useFakeTimers();
    platform = new BlinkSecurityPlatform(makeLogger(), config, makeApi());
    internals = platform as unknown as PollInternals;
    // Reconcile and characteristic pushes are out of scope here; the loop's
    // own scheduling is what is under test.
    internals.pushUpdates = () => {};
    internals.syncAccessories = () => {};
  });

  afterEach(() => {
    clearTimeout(internals.pollTimer);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reschedules the next poll when refreshData never settles', async () => {
    // Models the hung media/changed request: the promise stays pending, so a
    // loop that awaits it unbounded never reaches its reschedule.
    internals.blink = { refreshData: () => new Promise<void>(() => {}) };

    const cycle = internals.poll();
    // Let any bounded wait inside the cycle elapse.
    await vi.advanceTimersByTimeAsync(60_000);
    await cycle;

    expect(internals.pollTimer).toBeDefined();
  });

  it('reschedules the next poll when refreshData rejects', async () => {
    internals.blink = {
      refreshData: () => Promise.reject(new Error('boom')),
    };

    await internals.poll();

    expect(internals.pollTimer).toBeDefined();
  });
});
