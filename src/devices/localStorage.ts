import type { LocalStorageClip, MediaEntry, SyncModule } from '../lib/api.js';
import type { BlinkCamera } from './camera.js';
import type { ExponentialBackoff } from '../lib/utils.js';

// Synthesized media entries carry this source so the doorbell press filter
// (which only accepts "button"/"button_press") never mistakes a local clip
// for a button press — the manifest has no source field, so presses and PIR
// motion are indistinguishable on the local storage path.
export const LOCAL_STORAGE_SOURCE = 'local_storage';

export interface LocalStoragePollState {
  nextPollAt: number;
  backoff: ExponentialBackoff;
  active: boolean;
  inFlight: boolean;
  successLogged: boolean;
}

/**
 * Manifest clips identify cameras by an alphanumeric-only rendering of the
 * camera name (e.g. "Front Door" -> "frontdoor"), not by device ID.
 */
export function toAlphanumeric(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function isLocalStorageActive(syncModule?: SyncModule): boolean {
  return Boolean(
    syncModule &&
    syncModule.local_storage_enabled &&
    syncModule.local_storage_compatible !== false &&
    syncModule.local_storage_status === 'active'
  );
}

/**
 * Map alphanumeric camera names to devices for one network. Devices whose
 * names collide after normalization are excluded — attributing an ambiguous
 * clip to the wrong camera would fire false motion events.
 */
export function buildLocalCameraNameMap(
  devices: Iterable<BlinkCamera>,
  networkID: number
): Map<string, BlinkCamera> {
  const map = new Map<string, BlinkCamera>();
  const collisions = new Set<string>();
  for (const device of devices) {
    if (device.networkID !== networkID) {
      continue;
    }
    const key = toAlphanumeric(device.data.name ?? '');
    if (!key) {
      continue;
    }
    if (map.has(key)) {
      collisions.add(key);
    }
    map.set(key, device);
  }
  for (const key of collisions) {
    map.delete(key);
  }
  return map;
}

export function clipToMediaEntry(
  clip: LocalStorageClip,
  device: BlinkCamera
): MediaEntry {
  return {
    id: Number(clip.id) || 0,
    created_at: clip.created_at,
    updated_at: clip.created_at,
    device_id: device.cameraID,
    network_id: device.networkID,
    device: device.model ?? '',
    source: LOCAL_STORAGE_SOURCE,
    // Local clips have no cloud thumbnail; all consumers guard on truthiness
    // and fall back to the camera's own thumbnail.
    thumbnail: '',
  };
}
