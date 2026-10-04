import { Logger } from 'homebridge';

import {
  BlinkApi,
  type CameraSettings,
  type CommandResponse,
  type HomescreenCamera,
  type HomescreenSiren,
  type MediaEntry,
} from '../lib/api.js';
import type { BlinkAuthClient } from '../lib/auth.js';
import { DEFAULT_OPTIONS, type BlinkOptions } from '../lib/config.js';
import { routineInfo } from '../lib/logInfo.js';
import { BlinkNetwork, type NetworkData } from './network.js';
import { BlinkCamera, KNOWN_OWL_CODENAMES } from './camera.js';
import { BlinkDoorbell } from './doorbell.js';
import { BlinkSiren } from './siren.js';
import {
  buildLocalCameraNameMap,
  clipToMediaEntry,
  isLocalStorageActive,
  toAlphanumeric,
  DOORBELL_PRESS_SOURCES,
  MAX_CLIP_FUTURE_SKEW_MS,
  type LocalStoragePollState,
} from './localStorage.js';
import { ExponentialBackoff } from '../lib/utils.js';

export { BlinkDevice } from './base.js';
export { BlinkNetwork } from './network.js';
export { BlinkCamera } from './camera.js';
export { BlinkDoorbell } from './doorbell.js';
export { BlinkSiren } from './siren.js';

export const THUMBNAIL_TTL = 60 * 60;
export const MOTION_POLL = 15;
export const STATUS_POLL = 20;
export const ARMED_DELAY = 60;
export const MOTION_TRIGGER_DECAY = 90;
export const DOORBELL_DEVICE_TYPE = 'lotus';
// How long a refused doorbell config is taken as the answer before Blink is
// asked again. A refusal says nothing about how long it holds, so it is
// neither re-asked on every poll nor trusted for good.
export const DOORBELL_REFUSAL_TTL = 60 * 60;
// Local-storage manifest polling is heavier than the cloud media check
// (command POST + completion polling + manifest GET), so it runs on its own
// slower cadence than the main refresh loop.
export const LOCAL_STORAGE_POLL = 20;
export const LOCAL_STORAGE_STARTUP_DELAY = 90;

/** A doorbell known from the accessory cache rather than from Blink. */
export interface CachedDoorbell {
  id: number;
  networkID: number;
  canonicalID: string;
  // For log lines only. It carries the accessory prefixes, so the device's
  // own name cannot be recovered from it.
  displayName: string;
}

export class Blink {
  readonly api: BlinkApi;
  readonly log: Logger;
  readonly options: BlinkOptions;
  networks = new Map<number, BlinkNetwork>();
  cameras = new Map<number, BlinkCamera>();
  doorbells = new Map<number, BlinkDoorbell>();
  sirens = new Map<number, BlinkSiren>();

  private readonly statusPoll: number;
  private readonly motionPoll: number;
  private readonly snapshotRate: number;
  // Newest local-storage clip per camera, synthesized as MediaEntry so the
  // existing motion consumers work unchanged (see getCameraLastMotion).
  // discoveredAt drives the motion trigger window: a clip's created_at is
  // its recording START time and can already be older than the 90s decay by
  // the time the manifest surfaces it (recording length + manifest lag +
  // poll cadence), which would silently drop the event. discoveredAt of 0
  // marks a baseline clip (seen on the first manifest read, #56): stored
  // for thumbnails and dedup, never motion.
  private readonly localMedia = new Map<
    number,
    { entry: MediaEntry; discoveredAt: number }
  >();

  private readonly localStorageState = new Map<number, LocalStoragePollState>();
  // Homescreen collections already reported as unrecognized, so the warning
  // fires once per group rather than on every poll.
  private readonly unknownDeviceGroups = new Set<string>();
  // Doorbells the homescreen has actually listed. Doorbells found through the
  // media fallback are absent from it by nature, so their absence must never
  // be read as a removal.
  private readonly homescreenDoorbells = new Set<number>();
  // Doorbells this install already exposes to HomeKit, from the accessory
  // cache, that no refresh has accounted for yet. They are asked about by ID
  // so that keeping them never depends on what the media window happens to
  // hold at startup.
  private readonly cachedDoorbells = new Map<number, CachedDoorbell>();
  // When Blink last refused each device's doorbell config.
  private readonly doorbellRefusals = new Map<number, number>();
  /**
   * Canonical IDs of cached devices Blink has given no usable verdict on.
   * Their accessories must be kept: nothing says the device is gone.
   */
  readonly unresolvedDevices = new Set<string>();
  // Devices seen in media that the account does not list, already reported.
  private readonly unlistedMediaDevices = new Set<number>();
  // Last logged cloud media summary, so getMergedMedia only logs when the
  // media list actually changes rather than on every camera every poll.
  private mediaTrace = '';

  constructor(
    authClient: BlinkAuthClient,
    log: Logger,
    statusPoll = STATUS_POLL,
    motionPoll = MOTION_POLL,
    snapshotRate = THUMBNAIL_TTL,
    options: BlinkOptions = DEFAULT_OPTIONS
  ) {
    this.options = options;
    this.api = new BlinkApi(authClient, log, options);
    this.log = log;
    this.statusPoll = statusPoll ?? STATUS_POLL;
    // Cap the media cache TTL at the poll cadence: a TTL longer than the
    // poll interval makes every other cycle reuse stale media, doubling
    // worst-case motion/doorbell notification latency for no API savings.
    this.motionPoll = Math.min(
      motionPoll ?? MOTION_POLL,
      options.blinkStatusPollingSeconds || MOTION_POLL
    );
    this.snapshotRate = snapshotRate ?? THUMBNAIL_TTL;
  }

  protected createNetwork(data: NetworkData): BlinkNetwork {
    return new BlinkNetwork(data, this);
  }

  protected createCamera(
    data: HomescreenCamera,
    isOwlDevice = false
  ): BlinkCamera {
    return new BlinkCamera(data, this, isOwlDevice);
  }

  protected createDoorbell(
    data: HomescreenCamera,
    isOwlDevice = false
  ): BlinkDoorbell {
    return new BlinkDoorbell(data, this, isOwlDevice);
  }

  protected createSiren(data: HomescreenSiren): BlinkSiren {
    return new BlinkSiren(data, this);
  }

  /**
   * Warn once per unrecognized homescreen collection that looks like it
   * holds devices. Blink introduced `owls` as a sibling of `cameras` for the
   * Mini family; if a future hardware family arrives the same way, its
   * devices would otherwise be dropped silently with no accessory and no
   * log line to explain why.
   */
  private warnUnknownHomescreenDevices(homescreen: unknown): void {
    // Collections this plugin handles.
    const handled = new Set([
      'cameras',
      'owls',
      'doorbells',
      'doorbell_buttons',
      'networks',
      'sync_modules',
      'sirens',
    ]);
    // Collections Blink sends that are deliberately not exposed to HomeKit.
    // Warning about these would ask users to report hardware and account
    // metadata the plugin has no intention of supporting.
    const ignored = new Set([
      'chimes',
      'ring_devices',
      'accessories',
      'app_updates',
      'subscriptions',
      'entitlements',
      'device_limits',
      'tiv_lock_status',
      'whats_new',
      'account',
      'video_stats',
    ]);

    for (const [key, value] of Object.entries(
      (homescreen ?? {}) as Record<string, unknown>
    )) {
      if (
        handled.has(key) ||
        ignored.has(key) ||
        this.unknownDeviceGroups.has(key)
      ) {
        continue;
      }
      // Only report collections that look like CAMERAS specifically: a
      // network_id plus a camera-ish field. Matching on a bare `id` swept up
      // subscriptions, entitlements and other account metadata.
      const looksLikeCameras =
        Array.isArray(value) &&
        value.length > 0 &&
        value.some(
          entry =>
            typeof entry === 'object' &&
            entry !== null &&
            'network_id' in entry &&
            ['type', 'serial', 'thumbnail', 'fw_version'].some(k => k in entry)
        );
      if (!looksLikeCameras) {
        continue;
      }
      this.unknownDeviceGroups.add(key);
      this.log.warn(
        `Blink returned ${(value as unknown[]).length} device(s) in an ` +
          `unrecognized "${key}" group; they are not exposed to HomeKit. ` +
          'Please report this so support can be added: ' +
          'https://github.com/BitWise-0x/homebridge-blink-security/issues'
      );
    }
  }

  /**
   * Report, once, a device that has recent clips but is not on the account's
   * device list. Usually a camera that was removed while its clips are still
   * in the media window. Named so a device the plugin fails to list can be
   * told apart from one that is simply gone.
   */
  private noteUnlistedMediaDevice(
    entry: MediaEntry,
    knownCameraIds: Set<number>
  ): void {
    const id = entry.device_id;
    if (knownCameraIds.has(id) || this.unlistedMediaDevices.has(id)) {
      return;
    }
    this.unlistedMediaDevices.add(id);
    this.log.info(
      `Blink has recent clips from "${entry.device_name ?? 'unnamed'}" ` +
        `(type ${entry.device}, id ${id}), which is not on the account's ` +
        'device list. It is ignored.'
    );
  }

  /**
   * Doorbells the accessory cache already holds, handed over before the
   * first refresh.
   */
  seedCachedDoorbells(doorbells: CachedDoorbell[]): void {
    for (const doorbell of doorbells) {
      this.cachedDoorbells.set(doorbell.id, doorbell);
    }
  }

  /**
   * Ask Blink for a device's doorbell config. A refusal is remembered for
   * DOORBELL_REFUSAL_TTL; `unanswered` means the request failed and says
   * nothing about the device.
   */
  private async askDoorbellConfig(
    networkID: number,
    id: number,
    ttl: number
  ): Promise<Record<string, unknown> | 'refused' | 'unanswered'> {
    const refusedAt = this.doorbellRefusals.get(id);
    if (
      refusedAt !== undefined &&
      Date.now() - refusedAt < DOORBELL_REFUSAL_TTL * 1000
    ) {
      return 'refused';
    }
    try {
      const config = await this.api.probeDoorbellConfig(networkID, id, ttl);
      if (config) {
        this.doorbellRefusals.delete(id);
        return config as unknown as Record<string, unknown>;
      }
      this.doorbellRefusals.set(id, Date.now());
      return 'refused';
    } catch (err) {
      this.log.debug(`Failed to fetch config for doorbell ${id}: ${err}`);
      return 'unanswered';
    }
  }

  /**
   * Build a homescreen-shaped entry for a doorbell the homescreen does not
   * list. The config endpoint may return fields under different names (e.g.
   * camera_id instead of id) or nest them, so the ID and network come from
   * the caller and the config fills in what it provides.
   */
  private synthesizeDoorbell(
    id: number,
    networkID: number,
    raw: Record<string, unknown>,
    fallback: { thumbnail?: string }
  ): HomescreenCamera {
    return {
      id: (raw.id as number) ?? id,
      network_id: (raw.network_id as number) ?? networkID,
      name: (raw.name as string) ?? `Doorbell ${id}`,
      serial: (raw.serial as string) ?? '',
      fw_version: (raw.fw_version as string) ?? '',
      type: (raw.type as string) ?? DOORBELL_DEVICE_TYPE,
      enabled: (raw.enabled as boolean) ?? true,
      thumbnail: (raw.thumbnail as string) ?? fallback.thumbnail ?? '',
      status: (raw.status as string) ?? 'online',
      battery: raw.battery as string | undefined,
      signals: raw.signals as HomescreenCamera['signals'],
      created_at: (raw.created_at as string) ?? new Date().toISOString(),
      updated_at: (raw.updated_at as string) ?? new Date().toISOString(),
    };
  }

  /** Fold a fresh config into a doorbell that is already tracked. */
  private async refreshedDoorbell(
    doorbell: BlinkDoorbell,
    raw: Record<string, unknown>
  ): Promise<HomescreenCamera> {
    const current = doorbell.data;

    // Use thumbnail from config if available, otherwise check recent
    // media for a newer one (e.g. after a post-stream thumbnail refresh).
    let thumbnail = (raw.thumbnail as string) || current.thumbnail;
    const lastMedia = await this.getCameraLastMotion(
      doorbell.networkID,
      doorbell.cameraID
    ).catch(() => undefined);
    if (lastMedia?.thumbnail) {
      const mediaTime = Date.parse(lastMedia.created_at) || 0;
      if (mediaTime > doorbell.thumbnailCreatedAt || !thumbnail) {
        thumbnail = lastMedia.thumbnail;
      }
    }

    // Preserve synthesized id/network_id, update other fields
    return {
      ...current,
      name: (raw.name as string) ?? current.name,
      serial: (raw.serial as string) ?? current.serial,
      fw_version: (raw.fw_version as string) ?? current.fw_version,
      enabled: (raw.enabled as boolean) ?? current.enabled,
      status: (raw.status as string) ?? current.status,
      battery: raw.battery as string | undefined,
      thumbnail,
      updated_at: (raw.updated_at as string) ?? current.updated_at,
    };
  }

  /**
   * Settle every doorbell that is already known (tracked this session, or
   * held in the accessory cache) but that the homescreen does not list, by
   * asking Blink for it by ID.
   *
   * A known doorbell is only given up on corroborated evidence: Blink
   * refuses its config AND the homescreen is listing other doorbells
   * without it. A refusal alone, a failed request, or an empty homescreen
   * list all keep it, because unregistering discards HomeKit state that no
   * later poll can restore.
   */
  private async resolveKnownDoorbells(
    listedIds: Set<number>,
    ttl: number
  ): Promise<HomescreenCamera[]> {
    const known: (CachedDoorbell & { device?: BlinkDoorbell })[] = [];
    for (const [id, cached] of this.cachedDoorbells) {
      if (listedIds.has(id) || this.doorbells.has(id)) {
        this.cachedDoorbells.delete(id);
      } else {
        known.push(cached);
      }
    }
    for (const [id, device] of this.doorbells) {
      // A doorbell the homescreen used to list and now omits, while still
      // listing others, is removed on that list by pruneRemovedDevices.
      const droppedFromList =
        this.homescreenDoorbells.has(id) && listedIds.size > 0;
      if (!listedIds.has(id) && !droppedFromList) {
        known.push({
          id,
          networkID: device.networkID,
          canonicalID: device.canonicalID,
          displayName: device.name,
          device,
        });
      }
    }

    this.unresolvedDevices.clear();
    const resolved: HomescreenCamera[] = [];
    for (const { id, networkID, canonicalID, displayName, device } of known) {
      const firstRefusal = !this.doorbellRefusals.has(id);
      const answer = await this.askDoorbellConfig(networkID, id, ttl);

      if (typeof answer === 'object') {
        resolved.push(
          device
            ? await this.refreshedDoorbell(device, answer)
            : this.synthesizeDoorbell(id, networkID, answer, {})
        );
        continue;
      }

      if (answer === 'refused' && listedIds.size > 0) {
        this.cachedDoorbells.delete(id);
        if (device) {
          this.doorbells.delete(id);
          this.localMedia.delete(id);
        }
        this.log.info(
          `Doorbell "${displayName}" is no longer on the account and was ` +
            'removed'
        );
        continue;
      }

      if (answer === 'refused' && firstRefusal) {
        this.log.warn(
          `Blink refused the config of doorbell "${displayName}". It is kept in ` +
            'HomeKit. If it was removed from the Blink account, remove it ' +
            'from the Homebridge accessory cache.'
        );
      }
      if (device) {
        resolved.push(device.data);
      } else {
        this.unresolvedDevices.add(canonicalID);
      }
    }
    return resolved;
  }

  /**
   * Find doorbells the homescreen does not list from recent media.
   *
   * A device is only probed on positive evidence that it is a doorbell: the
   * doorbell codename, or a button press, which nothing else produces.
   * Being absent from the camera list is not evidence. A removed camera and
   * the device groups this plugin ignores are absent too, and probing those
   * asked Blink the same refused question on every poll (#76).
   */
  private async discoverDoorbellsFromMedia(
    allCameras: HomescreenCamera[],
    ttl: number
  ): Promise<HomescreenCamera[]> {
    const mediaRes = await this.api.getMediaChange(ttl).catch(err => {
      this.log.debug(`Doorbell discovery could not read media: ${err}`);
      return { media: [] as MediaEntry[] };
    });

    const knownCameraIds = new Set([
      ...allCameras.map(c => c.id),
      ...this.cameras.keys(),
    ]);
    const candidates = new Map<number, MediaEntry>();
    for (const entry of mediaRes.media ?? []) {
      const id = entry.device_id;
      // Known doorbells are settled by resolveKnownDoorbells.
      if (this.doorbells.has(id) || this.cachedDoorbells.has(id)) {
        continue;
      }
      const isCandidate =
        entry.device === DOORBELL_DEVICE_TYPE ||
        (entry.source !== undefined &&
          DOORBELL_PRESS_SOURCES.includes(entry.source));
      if (!isCandidate) {
        this.noteUnlistedMediaDevice(entry, knownCameraIds);
      } else if (!candidates.has(id)) {
        candidates.set(id, entry);
      }
    }

    const discovered: HomescreenCamera[] = [];
    for (const [id, entry] of candidates) {
      const answer = await this.askDoorbellConfig(entry.network_id, id, ttl);
      if (typeof answer !== 'object') {
        continue;
      }
      const doorbell = this.synthesizeDoorbell(id, entry.network_id, answer, {
        thumbnail: entry.thumbnail,
      });
      this.log.info(
        `Blink doorbell "${doorbell.name}" is not on the account's device ` +
          'list; it was found through its recent clips'
      );
      discovered.push(doorbell);
    }
    return discovered;
  }

  /** Announce a device that appeared after startup. */
  private logNewDevice(kind: string, name: string): void {
    this.log.info(`Blink discovered a new ${kind} "${name}"`);
  }

  /**
   * Drop devices that are gone from the account so their HomeKit accessories
   * can be removed and they stop being polled.
   *
   * Losing every device at once is treated as an API or auth problem rather
   * than a real mass deletion: dropping them would tear down the user's
   * HomeKit configuration, which cannot be recovered by a later poll.
   */
  private pruneRemovedDevices(
    networks: { id: number }[],
    cameras: HomescreenCamera[],
    doorbells: HomescreenCamera[],
    sirens: HomescreenSiren[]
  ): void {
    /**
     * Remove tracked devices of one kind that the account no longer lists.
     *
     * The empty check is per kind, not per total: a response that returns one
     * siren but drops the whole `cameras` array is a partial fault, and a
     * combined count would sail straight past it and delete every camera.
     */
    const drop = <T extends { data: { name?: string } }>(
      tracked: Map<number, T>,
      presentIDs: Set<number>,
      kind: string,
      eligible: (id: number) => boolean = () => true
    ) => {
      const candidates = [...tracked.keys()].filter(eligible);
      if (presentIDs.size === 0 && candidates.length > 0) {
        this.log.warn(
          `Blink reported no ${kind}s; keeping the ${candidates.length} ` +
            'already known rather than removing them'
        );
        return;
      }
      for (const id of candidates) {
        if (!presentIDs.has(id)) {
          const device = tracked.get(id)!;
          tracked.delete(id);
          this.localMedia.delete(id);
          this.log.info(
            `Blink ${kind} "${device.data.name ?? id}" is no longer on the ` +
              'account and was removed'
          );
        }
      }
    };

    drop(this.networks, new Set(networks.map(n => n.id)), 'network');
    drop(this.cameras, new Set(cameras.map(c => c.id)), 'camera');
    // Doorbells discovered through the media fallback never appear in the
    // homescreen, so the homescreen is not authoritative for them. Only
    // consider doorbells it has actually reported at some point.
    drop(this.doorbells, new Set(doorbells.map(d => d.id)), 'doorbell', id =>
      this.homescreenDoorbells.has(id)
    );
    drop(this.sirens, new Set(sirens.map(s => s.id)), 'siren');
  }

  async refreshData(force = false) {
    const ttl = force ? 0.1 : this.statusPoll;
    const homescreen = await this.api.getAccountHomescreen(ttl);

    this.warnUnknownHomescreenDevices(homescreen);

    const owls = homescreen.owls ?? [];
    const owlIds = new Set(owls.map(o => o.id));
    const allCameras: HomescreenCamera[] = [
      ...(homescreen.cameras ?? []),
      ...owls,
    ];

    const listedDoorbells: HomescreenCamera[] = [
      ...(homescreen.doorbells ?? []),
      ...(homescreen.doorbell_buttons ?? []),
    ];
    const listedDoorbellIds = new Set(listedDoorbells.map(d => d.id));
    // Recorded so pruning knows which doorbells the homescreen is
    // authoritative for.
    for (const doorbell of listedDoorbells) {
      this.homescreenDoorbells.add(doorbell.id);
    }

    // The homescreen is the authority for the doorbells it lists. Doorbells
    // it does not list are settled individually, and new ones are only
    // looked for when it lists none at all. Nothing is looked for when
    // doorbells are hidden: it would not be exposed.
    let allDoorbells = listedDoorbells;
    if (!this.options.noDoorbells) {
      const known = await this.resolveKnownDoorbells(listedDoorbellIds, ttl);
      const discovered =
        listedDoorbells.length === 0
          ? await this.discoverDoorbellsFromMedia(allCameras, ttl)
          : [];
      allDoorbells = [...listedDoorbells, ...known, ...discovered];
    }

    // Exclude unlisted doorbells from the camera list to prevent duplicates
    const doorbellIdSet = new Set(allDoorbells.map(d => d.id));
    const filteredCameras = allCameras.filter(c => !doorbellIdSet.has(c.id));

    const allSirens: HomescreenSiren[] = [...(homescreen.sirens ?? [])];

    for (const network of homescreen.networks) {
      (network as NetworkData).syncModule = homescreen.sync_modules.find(
        sm => sm.network_id === network.id
      );
    }

    if (this.networks.size > 0) {
      for (const n of homescreen.networks) {
        if (this.networks.has(n.id)) {
          this.networks.get(n.id)!.data = n as NetworkData;
        } else {
          this.networks.set(n.id, this.createNetwork(n as NetworkData));
        }
      }
      // Devices added to the account while Homebridge is running are tracked
      // here; the platform reconciles HomeKit accessories on the same poll,
      // so they appear without a restart.
      for (const c of filteredCameras) {
        if (this.cameras.has(c.id)) {
          this.cameras.get(c.id)!.data = c;
        } else {
          this.cameras.set(c.id, this.createCamera(c, owlIds.has(c.id)));
          this.logNewDevice('camera', c.name);
        }
      }
      for (const d of allDoorbells) {
        if (this.doorbells.has(d.id)) {
          this.doorbells.get(d.id)!.data = d;
        } else {
          this.doorbells.set(d.id, this.createDoorbell(d, owlIds.has(d.id)));
          this.logNewDevice('doorbell', d.name);
        }
      }

      this.pruneRemovedDevices(
        homescreen.networks,
        filteredCameras,
        allDoorbells,
        allSirens
      );
      for (const s of allSirens) {
        if (this.sirens.has(s.id)) {
          this.sirens.get(s.id)!.data = s;
        } else {
          this.sirens.set(s.id, this.createSiren(s));
        }
      }
    } else {
      this.networks = new Map(
        homescreen.networks.map(n => [
          n.id,
          this.createNetwork(n as NetworkData),
        ])
      );
      this.cameras = new Map(
        filteredCameras.map(c => [c.id, this.createCamera(c, owlIds.has(c.id))])
      );
      this.doorbells = new Map(
        allDoorbells.map(d => [d.id, this.createDoorbell(d, owlIds.has(d.id))])
      );
      this.sirens = new Map(allSirens.map(s => [s.id, this.createSiren(s)]));

      for (const camera of this.cameras.values()) {
        this.log.debug(
          `Camera ${camera.cameraID} "${camera.data.name}" type=${camera.model}, isCameraMini=${camera.isCameraMini}`
        );
        // Owl-array members are already routed through the owl endpoints via
        // `isOwlDevice`, so motion works regardless of codename. Surfacing an
        // unrecognized one is purely so it can be documented — this is how we
        // learned about #40 "superior" and #51 "chickadee". Nothing is broken.
        if (
          owlIds.has(camera.cameraID) &&
          !KNOWN_OWL_CODENAMES.includes(camera.model ?? '')
        ) {
          this.log.info(
            `Camera ${camera.cameraID} "${camera.data.name}" reports a new ` +
              `owl-family type "${camera.model}". Motion control is handled ` +
              'automatically, but please report this type so it can be ' +
              'documented: ' +
              'https://github.com/BitWise-0x/homebridge-blink-security/issues'
          );
        }
      }
    }

    // Local-storage motion fallback (before press checks so fresh local
    // entries feed the same cycle)
    await this.pollLocalStorage().catch(err => {
      this.log.debug(`Local storage poll failed: ${err}`);
    });

    // Check for doorbell press events
    for (const doorbell of this.doorbells.values()) {
      await doorbell.checkForPress().catch(err => {
        this.log.debug(`Doorbell press check failed: ${err}`);
      });
    }

    return homescreen;
  }

  /**
   * Poll the sync module local-storage manifest for new clips and surface
   * them as motion events. This is the only motion source for accounts
   * without Blink cloud clip storage (no subscription), where media/changed
   * is always empty (#55). In "auto" mode the fallback engages only while
   * the cloud media list is empty, so subscribers never pay the extra cost.
   */
  private async pollLocalStorage(): Promise<void> {
    const mode = this.options.localStorageMotion;
    if (mode === 'never') {
      return;
    }

    let cloudMediaEmpty: boolean | undefined;
    if (mode === 'auto') {
      // Same cached request the motion path makes — effectively free.
      const res = await this.api
        .getMediaChange(this.motionPoll)
        .catch(() => undefined);
      if (!res) {
        return;
      }
      cloudMediaEmpty = (res.media || []).length === 0;
    }

    for (const network of this.networks.values()) {
      const syncModule = network.syncModule;
      const eligible =
        isLocalStorageActive(syncModule) &&
        syncModule!.status === 'online' &&
        (mode === 'always' || cloudMediaEmpty === true);

      const state = this.localStorageState.get(network.networkID) ?? {
        // Defer the first manifest attempt past the startup thumbnail
        // refresh burst — every camera's refresh is a network command, and
        // the manifest request would spend its whole busy-retry window
        // colliding with them.
        nextPollAt: Date.now() + LOCAL_STORAGE_STARTUP_DELAY * 1000,
        backoff: new ExponentialBackoff(
          LOCAL_STORAGE_POLL * 1000,
          10 * 60 * 1000
        ),
        active: false,
        inFlight: false,
        successLogged: false,
        baselined: false,
        baselinedDevices: new Set<number>(),
      };
      this.localStorageState.set(network.networkID, state);

      if (!eligible) {
        if (state.active) {
          state.active = false;
          // Clips recorded while the fallback is down are history by the
          // time it resumes; re-arm the baseline so the resume read
          // suppresses them instead of replaying them as motion (#56).
          state.baselined = false;
          state.baselinedDevices.clear();
          this.log.info(
            `${network.name}: local storage motion fallback deactivated`
          );
        }
        continue;
      }

      if (!state.active) {
        state.active = true;
        this.log.info(
          `${network.name}: no cloud clips available - using sync module ` +
            'local storage for motion events'
        );
      }

      if (state.inFlight || Date.now() < state.nextPollAt) {
        continue;
      }

      // Fire-and-forget: the manifest flow can spend up to a minute in
      // busy retries and must never stall the main poll loop (arm state,
      // cloud motion, press checks).
      state.inFlight = true;
      this.readLocalStorageManifest(network)
        .then(clipCount => {
          state.baselined = true;
          state.backoff.reset();
          state.nextPollAt = Date.now() + LOCAL_STORAGE_POLL * 1000;
          if (!state.successLogged) {
            state.successLogged = true;
            this.log.info(
              `${network.name}: local storage manifest read (${clipCount} clips)`
            );
          }
        })
        .catch(err => {
          const msg = `${network.name}: local storage manifest poll failed: ${err}`;
          // Keep failures visible without spamming: warn on the first and
          // then once per backoff plateau, debug in between.
          if (state.backoff.attempt === 0 || state.backoff.attempt % 5 === 0) {
            this.log.warn(msg);
          } else {
            this.log.debug(msg);
          }
          state.nextPollAt = Date.now() + state.backoff.delayMs;
          state.backoff.increment();
        })
        .finally(() => {
          state.inFlight = false;
        });
    }
  }

  private async readLocalStorageManifest(
    network: BlinkNetwork
  ): Promise<number> {
    const networkID = network.networkID;
    const syncModuleID = network.syncModule!.id;

    let requestID: number | undefined;
    const status = await this.api.lock(
      `localStorageManifest(${networkID})`,
      async () => {
        return this.api.command(networkID, async () => {
          const res = await this.api.requestLocalStorageManifest(
            networkID,
            syncModuleID
          );
          // Busy retries re-run this closure with an id-less busy body;
          // only capture a real id so a late busy response can't erase it.
          const id = res.id ?? res.command_id;
          if (id) {
            requestID = id;
          }
          return res;
        });
      }
    );
    if (!requestID) {
      // command() returns undefined when the network command slot stayed
      // busy for the whole retry window (e.g. thumbnail refreshes or the
      // sync module recording); a present response without an id is a
      // genuinely unexpected shape.
      throw new Error(
        status === undefined
          ? 'system busy, will retry'
          : 'manifest request returned no id'
      );
    }

    const manifest = await this.api.getLocalStorageManifest(
      networkID,
      syncModuleID,
      requestID
    );
    // A busy 409 body is returned rather than thrown by the client; don't
    // mistake it for a valid-but-empty manifest.
    if (manifest.manifest_id === undefined && manifest.clips === undefined) {
      throw new Error('manifest fetch returned no data');
    }
    // An empty manifest still runs the loop body's bookkeeping: the devices
    // visible on this read are baselined by it even when they have no clips.
    const clips = manifest.clips ?? [];

    const nameMap = buildLocalCameraNameMap(
      [...this.cameras.values(), ...this.doorbells.values()],
      networkID
    );

    // A read establishes a baseline when the network has not been baselined
    // yet — at startup, and again whenever the fallback resumes after
    // standing down. Its clips are already history, so they carry no
    // discovery stamp and cannot trip the motion window (#56). Suppression
    // is by manifest membership rather than created_at comparisons, since
    // manifest timestamps can't be trusted against our clock (see the
    // skew guard below).
    const state = this.localStorageState.get(networkID);
    const networkBaselined = state?.baselined ?? false;
    const skewCutoff = Date.now() + MAX_CLIP_FUTURE_SKEW_MS;
    // Every device visible on this read is baselined by it, whether or not
    // it has a clip in the manifest.
    const seenDevices = new Set(
      [...nameMap.values()].map(device => device.cameraID)
    );

    for (const clip of clips) {
      const device = nameMap.get(toAlphanumeric(clip.camera_name ?? ''));
      if (!device) {
        this.log.debug(
          `${network.name}: local clip for unmatched camera_name "${clip.camera_name}"`
        );
        continue;
      }

      const createdAt = Date.parse(clip.created_at) || 0;
      // A wildly future-dated clip would win every later comparison and
      // silence this camera until wall clock caught up.
      if (createdAt > skewCutoff) {
        this.log.warn(
          `${device.name}: ignoring local storage clip dated in the future ` +
            `(created_at=${clip.created_at}); check the sync module clock`
        );
        continue;
      }

      const existing = this.localMedia.get(device.cameraID);
      const existingAt = existing
        ? Date.parse(existing.entry.created_at) || 0
        : 0;
      // A device seen for the first time is baselined on its own terms even
      // if the network already was: doorbell fallback discovery can register
      // a device several cycles after the network's first read, and its
      // backlog is just as historical (#56).
      const fires =
        networkBaselined &&
        (state?.baselinedDevices.has(device.cameraID) ?? false);
      if (createdAt > existingAt) {
        this.localMedia.set(device.cameraID, {
          entry: clipToMediaEntry(clip, device),
          discoveredAt: fires ? Date.now() : 0,
        });
        // Raw created_at logged so clock-skew/timezone issues are visible in
        // debug logs from the field.
        this.log.debug(
          fires
            ? `${device.name}: new local storage clip (created_at=${clip.created_at})`
            : `${device.name}: baseline local storage clip, no motion ` +
                `(created_at=${clip.created_at})`
        );
      }
    }

    // Devices present on this read are baselined from here on. Recorded
    // after the loop so a device only starts firing on the read *after* the
    // one that first saw it.
    if (state) {
      for (const cameraID of seenDevices) {
        state.baselinedDevices.add(cameraID);
      }
    }

    return clips.length;
  }

  /**
   * When the newest local-storage clip for a camera was DISCOVERED (not
   * recorded). Motion freshness for local clips is measured from discovery:
   * by the time a clip surfaces in the manifest its recording start time
   * may already be outside the trigger decay window.
   */
  getLocalMediaTimestamp(cameraID: number): number {
    return this.localMedia.get(cameraID)?.discoveredAt ?? 0;
  }

  async setArmedState(networkID: number, arm = true): Promise<void> {
    const cmd = arm
      ? () => this.api.armNetwork(networkID)
      : () => this.api.disarmNetwork(networkID);

    await this.api.lock(`setArmedState(${networkID})`, async () => {
      await this.api.command(networkID, cmd);
    });

    await this.refreshData(true);
  }

  async setCameraMotionSensorState(
    networkID: number,
    cameraID: number,
    enabled = true
  ): Promise<void> {
    const camera = this.cameras.get(cameraID);

    let cmd: () => Promise<CommandResponse>;
    let route: string;
    if (camera?.isCameraMini) {
      cmd = () => this.api.updateOwlSettings(networkID, cameraID, { enabled });
      route = 'owl config';
    } else if (enabled) {
      cmd = () => this.api.enableCameraMotion(networkID, cameraID);
      route = 'camera enable';
    } else {
      cmd = () => this.api.disableCameraMotion(networkID, cameraID);
      route = 'camera disable';
    }
    this.log.debug(
      `setCameraMotionSensorState camera ${cameraID} (type=${camera?.model}) ` +
        `enabled=${enabled} → ${route} endpoint`
    );

    try {
      await this.api.lock(
        `setCameraMotionSensorState(${networkID}, ${cameraID})`,
        async () => {
          await this.api.command(networkID, cmd);
        }
      );
    } catch (err) {
      // Surface motion-routing failures with enough context to diagnose a
      // mis-routed owl-family device (issues #40, #51). If an owl-routed
      // command fails, the codename likely needs a path variant we don't
      // yet handle (e.g. /superior/ for floodlights) — log it so it can be
      // reported rather than failing silently behind a generic HomeKit error.
      const detail =
        `camera ${cameraID} "${camera?.data.name}" (type=${camera?.model}, ` +
        `owlArrayMember=${camera?.isOwlDevice ?? false}) via ${route} endpoint`;
      if (camera?.isCameraMini) {
        this.log.error(
          `Failed to set motion ${enabled ? 'enable' : 'disable'} for ${detail}. ` +
            'This owl-family device may need an endpoint variant this plugin ' +
            'does not yet handle. Please report the camera type and this error ' +
            'at https://github.com/BitWise-0x/homebridge-blink-security/issues — ' +
            `cause: ${err instanceof Error ? err.message : String(err)}`
        );
      } else {
        this.log.error(
          `Failed to set motion ${enabled ? 'enable' : 'disable'} for ${detail} — ` +
            `cause: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      throw err;
    }

    await this.refreshData(true);
  }

  async recordCameraClip(networkID: number, cameraID: number): Promise<void> {
    const camera = this.cameras.get(cameraID);
    const doorbell = this.doorbells.get(cameraID);

    let cmd: () => Promise<CommandResponse>;
    if (camera?.isCameraMini) {
      cmd = () => this.api.updateOwlClip(networkID, cameraID);
    } else if (doorbell) {
      cmd = () => this.api.updateDoorbellClip(networkID, cameraID);
    } else {
      cmd = () => this.api.updateCameraClip(networkID, cameraID);
    }

    await this.api.lock(
      `recordCameraClip(${networkID}, ${cameraID})`,
      async () => {
        await this.api.command(networkID, cmd);
      }
    );
  }

  async updateCameraSettings(
    networkID: number,
    cameraID: number,
    settings: CameraSettings
  ): Promise<void> {
    await this.api.lock(
      `updateCameraSettings(${networkID}, ${cameraID})`,
      async () => {
        await this.api.command(networkID, () =>
          this.api.updateCameraSettings(networkID, cameraID, settings)
        );
      }
    );
  }

  async activateSiren(
    networkID: number,
    sirenID: number,
    durationSeconds = 30
  ): Promise<void> {
    await this.api.lock(`activateSiren(${networkID}, ${sirenID})`, async () => {
      await this.api.command(networkID, () =>
        this.api.activateSiren(networkID, sirenID, durationSeconds)
      );
    });
  }

  async deactivateSirens(networkID: number): Promise<void> {
    await this.api.lock(`deactivateSirens(${networkID})`, async () => {
      await this.api.command(networkID, () =>
        this.api.deactivateSirens(networkID)
      );
    });
  }

  async setDoorbellMotionSensorState(
    networkID: number,
    doorbellID: number,
    enabled = true
  ): Promise<void> {
    const cmd = enabled
      ? () => this.api.enableDoorbellMotion(networkID, doorbellID)
      : () => this.api.disableDoorbellMotion(networkID, doorbellID);

    await this.api.lock(
      `setDoorbellMotionSensorState(${networkID}, ${doorbellID})`,
      async () => {
        await this.api.command(networkID, cmd);
      }
    );

    await this.refreshData(true);
  }

  async refreshCameraThumbnail(
    networkID?: number,
    cameraID?: number,
    force = false
  ): Promise<void> {
    const cameras = [...this.cameras.values()]
      .filter(camera => !networkID || camera.networkID === networkID)
      .filter(camera => !cameraID || camera.cameraID === cameraID);

    const status = await Promise.all(
      cameras.map(async camera => {
        const ttl = force ? 500 : this.snapshotRate * 1000;
        const lastSnapshot = camera.thumbnailCreatedAt + ttl;
        const eligible = force || (camera.armed && camera.enabled);

        if (eligible && Date.now() >= lastSnapshot) {
          if (camera.lowBattery || !camera.online) {
            routineInfo(
              this.log,
              this.options,
              `${camera.name} - ${!camera.online ? 'Offline' : 'Low Battery'}; Skipping snapshot`
            );
            return false;
          }

          camera.thumbnailCreatedAt = Date.now();

          routineInfo(
            this.log,
            this.options,
            `${camera.name} - Cloud thumbnail refresh (interval: ${this.snapshotRate}s)`
          );

          const updateCamera = camera.isCameraMini
            ? () =>
                this.api.updateOwlThumbnail(camera.networkID, camera.cameraID)
            : () =>
                this.api.updateCameraThumbnail(
                  camera.networkID,
                  camera.cameraID
                );

          await this.api.lock(
            `refreshCameraThumbnail(${camera.networkID}, ${camera.cameraID})`,
            async () => {
              await this.api.command(camera.networkID, updateCamera);
            }
          );

          return true;
        }
        if (eligible) {
          const secsRemaining = Math.ceil((lastSnapshot - Date.now()) / 1000);
          this.log.debug(
            `${camera.name} - Cloud refresh skipped (next in ${secsRemaining}s)`
          );
        }
        return false;
      })
    );

    if (status.includes(true)) {
      await this.refreshData(true);
    }
  }

  /**
   * Cloud media merged with synthesized local-storage entries, newest first,
   * scoped to a network and optionally a single device.
   */
  private async getMergedMedia(
    networkID: number,
    cameraID?: number
  ): Promise<MediaEntry[]> {
    const res = await this.api
      .getMediaChange(this.motionPoll)
      .catch(() => ({ media: [] }));
    const cloud = res.media || [];
    // Logged before the per-camera filters so a clip whose device_id or
    // network_id does not match any known device is still visible.
    const newest = [...cloud].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
    )[0];
    const trace = newest
      ? `${cloud.length} cloud clip(s), newest device_id=${newest.device_id} ` +
        `network_id=${newest.network_id} created_at=${newest.created_at}`
      : 'no cloud clips';
    if (trace !== this.mediaTrace) {
      this.mediaTrace = trace;
      this.log.debug(`Blink media: ${trace}`);
    }
    const local = [...this.localMedia.values()].map(rec => rec.entry);
    return [...cloud, ...local]
      .filter(m => !networkID || m.network_id === networkID)
      .filter(m => !cameraID || m.device_id === cameraID)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }

  async getCameraLastMotion(
    networkID: number,
    cameraID?: number
  ): Promise<MediaEntry | undefined> {
    return (await this.getMergedMedia(networkID, cameraID))[0];
  }

  /**
   * Newest doorbell button press. Presses are selected before picking a
   * winner because a local-storage clip of the same event is often stamped
   * a moment later than the cloud press entry; inspecting only the newest
   * entry would silently swallow the press.
   *
   * An entry with no source counts as a press: older Blink firmware omits
   * the field on doorbell media, and the caller only ever asks about a
   * doorbell. Synthesized local clips always carry a source, so they are
   * excluded here rather than relying on that absence.
   */
  async getCameraLastPress(
    networkID: number,
    cameraID?: number
  ): Promise<MediaEntry | undefined> {
    const media = await this.getMergedMedia(networkID, cameraID);
    return media.find(
      m => !m.source || DOORBELL_PRESS_SOURCES.includes(m.source)
    );
  }

  async getCameraLastThumbnail(
    networkID: number,
    cameraID: number
  ): Promise<string | undefined> {
    const camera = this.cameras.get(cameraID);
    if (!camera) {
      return undefined;
    }

    if (camera.thumbnailCreatedAt > camera.updatedAt - 60 * 1000) {
      return camera.thumbnail;
    }

    const latestMedia = await this.getCameraLastMotion(networkID, cameraID);
    if (
      latestMedia?.created_at &&
      Date.parse(latestMedia.created_at) > camera.thumbnailCreatedAt
    ) {
      return latestMedia.thumbnail;
    }
    return camera.thumbnail;
  }

  async getCameraLiveView(networkID: number, cameraID: number, timeout = 30) {
    const camera = this.cameras.get(cameraID);

    // Liveview POST returns the server URL immediately in the response.
    // Unlike other commands, we do NOT poll for completion — the command
    // stays "incomplete" while the stream is active. Polling would just
    // wait until timeout and discard the server URL.
    const fn = camera?.isCameraMini
      ? () => this.api.getOwlLiveView(networkID, cameraID)
      : () => this.api.getCameraLiveView(networkID, cameraID);

    const start = Date.now();
    const backoff = new ExponentialBackoff(1000, 10000, 2);
    let response = await fn();

    // Retry on "busy" (409) just like command() does
    while (
      response.message &&
      /busy/i.test(response.message) &&
      Date.now() - start < timeout * 1000
    ) {
      const delayMs = backoff.delayMs;
      routineInfo(
        this.log,
        this.options,
        `Sleeping ${Math.round(delayMs / 1000)}s: ${response.message}`
      );
      await backoff.wait();
      response = await fn();
    }

    return response;
  }

  async getDoorbellLiveView(
    networkID: number,
    doorbellID: number,
    timeout = 30
  ) {
    const fn = () => this.api.getDoorbellLiveView(networkID, doorbellID);

    const start = Date.now();
    const backoff = new ExponentialBackoff(1000, 10000, 2);
    let response = await fn();

    while (
      response.message &&
      /busy/i.test(response.message) &&
      Date.now() - start < timeout * 1000
    ) {
      const delayMs = backoff.delayMs;
      routineInfo(
        this.log,
        this.options,
        `Sleeping ${Math.round(delayMs / 1000)}s: ${response.message}`
      );
      await backoff.wait();
      response = await fn();
    }

    return response;
  }

  async refreshDoorbellThumbnail(
    networkID: number,
    doorbellID: number,
    force = false
  ): Promise<void> {
    const doorbell = this.doorbells.get(doorbellID);
    if (!doorbell) {
      return;
    }

    const ttl = force ? 500 : this.snapshotRate * 1000;
    const lastSnapshot = doorbell.thumbnailCreatedAt + ttl;
    const eligible = force || (doorbell.armed && doorbell.enabled);

    if (eligible && Date.now() >= lastSnapshot) {
      if (!doorbell.online) {
        routineInfo(
          this.log,
          this.options,
          `${doorbell.name} - Offline; Skipping snapshot`
        );
        return;
      }

      doorbell.thumbnailCreatedAt = Date.now();

      routineInfo(
        this.log,
        this.options,
        `${doorbell.name} - Cloud thumbnail refresh (interval: ${this.snapshotRate}s)`
      );

      await this.api.lock(
        `refreshDoorbellThumbnail(${networkID}, ${doorbellID})`,
        async () => {
          await this.api.command(networkID, () =>
            this.api.updateDoorbellThumbnail(networkID, doorbellID)
          );
        }
      );

      await this.refreshData(true);
    } else if (eligible) {
      const secsRemaining = Math.ceil((lastSnapshot - Date.now()) / 1000);
      this.log.debug(
        `${doorbell.name} - Cloud refresh skipped (next in ${secsRemaining}s)`
      );
    }
  }
}
