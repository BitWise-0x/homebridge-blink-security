import { describe, it, expect, vi } from 'vitest';
import {
  BlinkCameraDelegate,
  CONFIGURED_ACCESSORIES,
} from '../cameraDelegate.js';
import type { BlinkCamera } from '../../devices/camera.js';
import type { HAP, Logger } from 'homebridge';

/**
 * When a device disappears from the account its accessory is unregistered.
 * Anything the delegate still owns — ffmpeg children, TCP proxy servers,
 * pending timers — has no owner after that and must be released.
 */
function makeDelegate(): {
  delegate: BlinkCameraDelegate;
  internals: {
    ongoingSessions: Map<string, { kill: ReturnType<typeof vi.fn> }>;
    streamTimeouts: Map<string, ReturnType<typeof setTimeout>>;
    proxySessions: Map<
      string,
      { proxyServer?: { stop: ReturnType<typeof vi.fn> } }
    >;
  };
} {
  const camera = {
    name: 'Front Door',
    refreshThumbnail: vi.fn().mockResolvedValue(undefined),
    clearThumbnailCache: vi.fn(),
  } as unknown as BlinkCamera;
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const delegate = new BlinkCameraDelegate(
    camera,
    log,
    {} as unknown as HAP,
    true,
    false,
    true
  );
  return {
    delegate,
    internals: delegate as unknown as {
      ongoingSessions: Map<string, { kill: ReturnType<typeof vi.fn> }>;
      streamTimeouts: Map<string, ReturnType<typeof setTimeout>>;
      proxySessions: Map<
        string,
        { proxyServer?: { stop: ReturnType<typeof vi.fn> } }
      >;
    },
  };
}

describe('BlinkCameraDelegate.shutdown', () => {
  it('kills ffmpeg processes for every active session', async () => {
    const { delegate, internals } = makeDelegate();
    const kill = vi.fn();
    internals.ongoingSessions.set('s1', { kill });
    internals.ongoingSessions.set('s2', { kill });

    await delegate.shutdown();

    expect(kill).toHaveBeenCalledTimes(2);
    expect(internals.ongoingSessions.size).toBe(0);
  });

  it('stops proxy servers and clears pending timers', async () => {
    const { delegate, internals } = makeDelegate();
    const stop = vi.fn().mockResolvedValue(undefined);
    internals.proxySessions.set('s1', { proxyServer: { stop } });
    internals.streamTimeouts.set(
      's1',
      setTimeout(() => {}, 60_000)
    );

    await delegate.shutdown();

    expect(stop).toHaveBeenCalledOnce();
    expect(internals.proxySessions.size).toBe(0);
    expect(internals.streamTimeouts.size).toBe(0);
  });

  it('is safe to call with no active sessions', async () => {
    const { delegate } = makeDelegate();
    await expect(delegate.shutdown()).resolves.toBeUndefined();
  });

  // A stream retry parks in a sleep before rebuilding its tunnel. If the
  // accessory is torn down meanwhile, resuming would spawn a fresh ffmpeg
  // child and proxy server that nothing owns or will ever stop.
  it('stops an in-flight stream retry from resurrecting resources', async () => {
    const { delegate, internals } = makeDelegate();
    const getLiveViewURL = vi.fn();
    (
      delegate as unknown as { blinkCamera: { getLiveViewURL: unknown } }
    ).blinkCamera.getLiveViewURL = getLiveViewURL;

    const retry = (
      delegate as unknown as {
        retryImmiStream: (id: string, v: unknown, a: unknown) => Promise<void>;
      }
    ).retryImmiStream.call(delegate, 's1', {}, {});

    await delegate.shutdown();
    await retry;

    // Never got as far as requesting a new stream, and nothing was re-added.
    expect(getLiveViewURL).not.toHaveBeenCalled();
    expect(internals.ongoingSessions.size).toBe(0);
    expect(internals.proxySessions.size).toBe(0);
  });
});

/**
 * The "configure the camera controller only once" guard must not live on
 * `accessory.context`: Homebridge serializes context to its accessory cache
 * and restores it on boot, so a persisted flag would make every camera skip
 * controller setup after the first restart.
 */
describe('camera controller guard storage', () => {
  it('does not treat a context flag restored from disk as configured', () => {
    const restored = {
      UUID: 'u1',
      context: { _controllerConfigured: true },
    } as unknown as object;

    expect(CONFIGURED_ACCESSORIES.has(restored)).toBe(false);
  });

  it('tracks accessories per process rather than per context', () => {
    const accessory = { UUID: 'u1', context: {} } as unknown as object;
    expect(CONFIGURED_ACCESSORIES.has(accessory)).toBe(false);
    CONFIGURED_ACCESSORIES.add(accessory);
    expect(CONFIGURED_ACCESSORIES.has(accessory)).toBe(true);
    // A different object with identical context is unaffected.
    expect(
      CONFIGURED_ACCESSORIES.has({
        UUID: 'u1',
        context: {},
      } as unknown as object)
    ).toBe(false);
  });
});
