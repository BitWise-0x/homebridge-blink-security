import { describe, it, expect } from 'vitest';
import { BlinkCamera } from '../index.js';
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
