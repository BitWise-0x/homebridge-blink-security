import { describe, it, expect } from 'vitest';
import {
  LOCAL_STORAGE_SOURCE,
  buildLocalCameraNameMap,
  clipToMediaEntry,
  isLocalStorageActive,
  toAlphanumeric,
} from '../localStorage.js';
import { BlinkCamera } from '../index.js';
import type { HomescreenCamera } from '../base.js';
import type { SyncModule } from '../../lib/api.js';

type Blink = ConstructorParameters<typeof BlinkCamera>[1];

function makeCamera(
  id: number,
  name: string,
  networkID = 100,
  type = 'camera'
): BlinkCamera {
  const data: HomescreenCamera = {
    id,
    network_id: networkID,
    name,
    serial: `TEST${id}`,
    fw_version: '1.0.0',
    type,
    enabled: true,
    thumbnail: '',
    status: 'online',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  return new BlinkCamera(data, {} as Blink);
}

function makeSyncModule(overrides: Partial<SyncModule> = {}): SyncModule {
  return {
    id: 555,
    network_id: 100,
    name: 'sm',
    serial: 'SM0001',
    fw_version: '4.0.0',
    type: 'sm2',
    status: 'online',
    last_hb: '2026-01-01T00:00:00Z',
    wifi_strength: 3,
    local_storage_enabled: true,
    local_storage_compatible: true,
    local_storage_status: 'active',
    ...overrides,
  };
}

describe('toAlphanumeric', () => {
  it('strips spaces and punctuation and lowercases', () => {
    expect(toAlphanumeric('Front Door')).toBe('frontdoor');
    expect(toAlphanumeric("Bob's Cam #2!")).toBe('bobscam2');
    expect(toAlphanumeric('ALLCAPS')).toBe('allcaps');
  });

  it('returns empty string when nothing survives', () => {
    expect(toAlphanumeric('  --  ')).toBe('');
  });
});

describe('isLocalStorageActive', () => {
  it('is true for an enabled, compatible, active sync module', () => {
    expect(isLocalStorageActive(makeSyncModule())).toBe(true);
  });

  it('is false without a sync module', () => {
    expect(isLocalStorageActive(undefined)).toBe(false);
  });

  it('is false when local storage is disabled', () => {
    expect(
      isLocalStorageActive(makeSyncModule({ local_storage_enabled: false }))
    ).toBe(false);
  });

  it('is false when status is not active', () => {
    expect(
      isLocalStorageActive(
        makeSyncModule({ local_storage_status: 'unavailable' })
      )
    ).toBe(false);
  });

  it('is false when explicitly incompatible', () => {
    expect(
      isLocalStorageActive(makeSyncModule({ local_storage_compatible: false }))
    ).toBe(false);
  });

  it('tolerates a missing compatible flag', () => {
    expect(
      isLocalStorageActive(
        makeSyncModule({ local_storage_compatible: undefined })
      )
    ).toBe(true);
  });
});

describe('buildLocalCameraNameMap', () => {
  it('maps alphanumeric names to devices in the network', () => {
    const a = makeCamera(1, 'Front Door');
    const b = makeCamera(2, 'Garage');
    const map = buildLocalCameraNameMap([a, b], 100);
    expect(map.get('frontdoor')).toBe(a);
    expect(map.get('garage')).toBe(b);
  });

  it('excludes devices from other networks', () => {
    const a = makeCamera(1, 'Front Door', 100);
    const b = makeCamera(2, 'Patio', 200);
    const map = buildLocalCameraNameMap([a, b], 100);
    expect(map.has('patio')).toBe(false);
  });

  it('excludes colliding names entirely', () => {
    // "Front Door" and "front-door" normalize identically; attributing a
    // clip to either would risk false motion on the other.
    const a = makeCamera(1, 'Front Door');
    const b = makeCamera(2, 'front-door');
    const c = makeCamera(3, 'Garage');
    const map = buildLocalCameraNameMap([a, b, c], 100);
    expect(map.has('frontdoor')).toBe(false);
    expect(map.get('garage')).toBe(c);
  });
});

describe('clipToMediaEntry', () => {
  it('synthesizes a MediaEntry that cannot pass the doorbell press filter', () => {
    const camera = makeCamera(42, 'Front Door', 100, 'lotus');
    const entry = clipToMediaEntry(
      {
        id: '77',
        camera_name: 'FrontDoor',
        created_at: '2026-07-22T10:00:00Z',
      },
      camera
    );
    expect(entry.device_id).toBe(42);
    expect(entry.network_id).toBe(100);
    expect(entry.created_at).toBe('2026-07-22T10:00:00Z');
    expect(entry.source).toBe(LOCAL_STORAGE_SOURCE);
    expect(entry.thumbnail).toBe('');
    expect(entry.id).toBe(77);
  });

  it('tolerates a non-numeric clip id', () => {
    const camera = makeCamera(42, 'Front Door');
    const entry = clipToMediaEntry(
      {
        id: 'abc',
        camera_name: 'FrontDoor',
        created_at: '2026-07-22T10:00:00Z',
      },
      camera
    );
    expect(entry.id).toBe(0);
  });
});
