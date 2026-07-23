import { describe, it, expect, vi } from 'vitest';
import { BlinkCamera } from '../index.js';
import { LOCAL_STORAGE_SOURCE } from '../localStorage.js';
import type { HomescreenCamera } from '../base.js';

type Blink = ConstructorParameters<typeof BlinkCamera>[1];

function makeCamera(type: string, isOwlDevice = false): BlinkCamera {
  const data: HomescreenCamera = {
    id: 915774,
    network_id: 682119,
    name: 'Floodlight',
    serial: 'TEST0001',
    fw_version: '1.0.0',
    type,
    enabled: true,
    thumbnail: '',
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  return new BlinkCamera(data, {} as Blink, isOwlDevice);
}

describe('BlinkCamera device-type classification', () => {
  // Regression for issue #40: the Wired Floodlight reports type "superior"
  // and must route motion enable/disable through the owl config endpoint
  // rather than the legacy /network/.../camera/.../enable path (which 404s).
  it('treats a "superior" floodlight as a mini', () => {
    expect(makeCamera('superior').isCameraMini).toBe(true);
  });

  it('identifies a "superior" floodlight as a floodlight', () => {
    expect(makeCamera('superior').isFloodlight).toBe(true);
  });

  it('treats owl and hawk as minis', () => {
    expect(makeCamera('owl').isCameraMini).toBe(true);
    expect(makeCamera('hawk').isCameraMini).toBe(true);
  });

  // Regression for issue #51: the Blink Mini 2K+ reports type "chickadee"
  // and must be routed through the owl config endpoint, same as #40.
  it('treats a "chickadee" Mini 2K+ as a mini', () => {
    expect(makeCamera('chickadee').isCameraMini).toBe(true);
  });

  it('does not treat a regular camera as a mini', () => {
    const camera = makeCamera('camera');
    expect(camera.isCameraMini).toBe(false);
    expect(camera.isFloodlight).toBe(false);
  });

  // Membership in the homescreen `owls` array is the authoritative signal for
  // owl-endpoint routing (issues #40, #51 are recurrences of relying on the
  // codename allow-list alone). A device in that array must route through the
  // owl endpoints even when its codename is brand new and unrecognized.
  it('treats any owl-array member as a mini, even with an unknown codename', () => {
    expect(makeCamera('somefuturebird', true).isCameraMini).toBe(true);
  });

  it('still recognizes known codenames when not flagged as an owl device', () => {
    expect(makeCamera('owl', false).isCameraMini).toBe(true);
    expect(makeCamera('chickadee', false).isCameraMini).toBe(true);
  });

  it('does not treat an unknown codename as a mini unless it is an owl-array member', () => {
    expect(makeCamera('catalina', false).isCameraMini).toBe(false);
  });
});

describe('BlinkCamera.getMotionDetected with local storage events', () => {
  // Regression for issue #55: local-storage clips don't bump the homescreen
  // updated_at, so the staleness gate must also consider the local media
  // timestamp or manifest-sourced motion is silently suppressed.
  const staleIso = '2026-01-01T00:00:00Z';

  function makeArmedCamera(
    localMediaTimestamp: number,
    clipCreatedAt = localMediaTimestamp
  ): {
    camera: BlinkCamera;
    getCameraLastMotion: ReturnType<typeof vi.fn>;
  } {
    const data: HomescreenCamera = {
      id: 42,
      network_id: 100,
      name: 'Front Door',
      serial: 'TEST0042',
      fw_version: '1.0.0',
      type: 'camera',
      enabled: true,
      thumbnail: '',
      status: 'online',
      created_at: staleIso,
      updated_at: staleIso,
    };
    const network = {
      armed: true,
      updatedAt: Date.parse(staleIso),
      armedAt: Date.now() - 60 * 60 * 1000,
    };
    const getCameraLastMotion = vi.fn().mockResolvedValue({
      created_at: new Date(clipCreatedAt).toISOString(),
      source: LOCAL_STORAGE_SOURCE,
      device_id: 42,
      network_id: 100,
    });
    const blink = {
      networks: new Map([[100, network]]),
      getCameraLastMotion,
      getLocalMediaTimestamp: vi.fn().mockReturnValue(localMediaTimestamp),
    } as unknown as Blink;
    return { camera: new BlinkCamera(data, blink), getCameraLastMotion };
  }

  it('fires for a fresh local clip despite a stale homescreen updated_at', async () => {
    const { camera } = makeArmedCamera(Date.now() - 5 * 1000);
    await expect(camera.getMotionDetected()).resolves.toBe(true);
  });

  it('does not fire for a local clip older than the trigger decay', async () => {
    const { camera, getCameraLastMotion } = makeArmedCamera(
      Date.now() - 10 * 60 * 1000
    );
    await expect(camera.getMotionDetected()).resolves.toBe(false);
    // Suppressed by the staleness gate before any media fetch.
    expect(getCameraLastMotion).not.toHaveBeenCalled();
  });

  // A clip's created_at is its recording START time; recording length plus
  // manifest lag plus poll cadence can put it past the 90s decay before the
  // plugin ever sees it. Freshness must follow discovery, not recording.
  it('fires for a just-discovered clip whose recording started long ago', async () => {
    const { camera } = makeArmedCamera(
      Date.now() - 5 * 1000, // discovered 5s ago
      Date.now() - 5 * 60 * 1000 // recording started 5 minutes ago
    );
    await expect(camera.getMotionDetected()).resolves.toBe(true);
  });
});
