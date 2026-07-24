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
  // Regressions for issues #40 (superior/Wired Floodlight) and #51
  // (chickadee/Mini 2K+): owl-family devices must route motion enable through
  // the owl config endpoint rather than the legacy camera path, which 404s.
  // Membership in the homescreen `owls` array is the ONLY signal for that
  // routing — every one of these models is delivered in that array.
  it('treats owl-array members as minis regardless of codename', () => {
    expect(makeCamera('superior', true).isCameraMini).toBe(true);
    expect(makeCamera('owl', true).isCameraMini).toBe(true);
    expect(makeCamera('hawk', true).isCameraMini).toBe(true);
    expect(makeCamera('chickadee', true).isCameraMini).toBe(true);
  });

  // A brand-new hardware revision reports an unrecognized bird codename. It
  // must still route correctly on array membership alone — this is what
  // stopped #40/#51 from recurring for every future model.
  it('treats any owl-array member as a mini, even with an unknown codename', () => {
    expect(makeCamera('somefuturebird', true).isCameraMini).toBe(true);
  });

  it('does not treat a regular camera as a mini', () => {
    expect(makeCamera('camera').isCameraMini).toBe(false);
  });

  // The inverse of the #40/#51 lesson: a hardcoded codename must never
  // override the authoritative array. If Blink ever ships a known owl
  // codename in the plain `cameras` array, routing it to owl endpoints
  // would 404 exactly the way the original bug did.
  it('does not force a known codename onto owl endpoints outside the owls array', () => {
    expect(makeCamera('superior', false).isCameraMini).toBe(false);
    expect(makeCamera('chickadee', false).isCameraMini).toBe(false);
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
    clipCreatedAt = localMediaTimestamp,
    armedAt = Date.now() - 60 * 60 * 1000
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
      armedAt,
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
      log: { debug: vi.fn() },
    } as unknown as Blink;
    return { camera: new BlinkCamera(data, blink), getCameraLastMotion };
  }

  it('fires for a fresh local clip despite a stale homescreen updated_at', async () => {
    const { camera } = makeArmedCamera(Date.now() - 5 * 1000);
    await expect(camera.getMotionDetected()).resolves.toBe(true);
  });

  it('does not fire for a local clip older than the trigger decay', async () => {
    const { camera } = makeArmedCamera(Date.now() - 10 * 60 * 1000);
    await expect(camera.getMotionDetected()).resolves.toBe(false);
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

  // The homescreen's updated_at tracks device check-ins, not recordings, and
  // for battery cameras it can lag minutes behind a clip. Gating motion on it
  // dropped genuinely fresh events: the Blink app notified instantly while
  // HomeKit stayed silent.
  it('fires for a fresh clip even when the homescreen updated_at is stale', async () => {
    const { camera } = makeArmedCamera(
      0, // no local media
      Date.now() - 3 * 1000 // cloud clip recorded 3s ago
    );
    await expect(camera.getMotionDetected()).resolves.toBe(true);
  });

  // The armed gate must compare the EVENT time to the arm instant. Gating on
  // the current time is always satisfied once armed and suppresses nothing.
  it('does not fire for an event recorded well before the network was armed', async () => {
    // Discovered just now (so the decay window is open) but recorded long
    // before arming, and beyond the ARMED_DELAY grace period.
    const { camera } = makeArmedCamera(
      Date.now() - 5 * 1000,
      Date.now() - 5 * 1000,
      Date.now() + 10 * 60 * 1000
    );
    await expect(camera.getMotionDetected()).resolves.toBe(false);
  });

  it('fires for an event just inside the pre-arm grace window', async () => {
    const armedAt = Date.now();
    const { camera } = makeArmedCamera(
      armedAt - 10 * 1000,
      armedAt - 10 * 1000,
      armedAt
    );
    await expect(camera.getMotionDetected()).resolves.toBe(true);
  });
});
