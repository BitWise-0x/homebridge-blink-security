import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  type BlinkSecurityConfig,
  normalizeConfig,
  type BlinkOptions,
} from './lib/config.js';
import { BlinkAuthClient, BlinkAuth2FARequiredError } from './lib/auth.js';
import { routineInfo } from './lib/logInfo.js';
import { ExponentialBackoff, withTimeout } from './lib/utils.js';
import {
  Blink,
  type BlinkCamera,
  type BlinkDoorbell,
  type BlinkNetwork,
  type BlinkSiren,
  type CachedDoorbell,
} from './devices/index.js';
import { SecuritySystemAccessory } from './accessories/securitySystem.js';
import { CameraAccessory } from './accessories/camera.js';
import { DoorbellAccessory } from './accessories/doorbell.js';
import { SirenAccessory } from './accessories/siren.js';

// Above the 30s client timeout so a single stalled request fails first and
// names the stuck URL. This is the outer backstop for a hang no per-request
// timeout covers, and withTimeout does not cancel the work it bounds, so
// firing first would only orphan a request the socket is still waiting on.
const POLL_CYCLE_TIMEOUT_MS = 40000;
// How long Blink must keep omitting a device, while still reporting others of
// its kind, before the accessory is unregistered. One short or partial
// response must not cost the user rooms, names, scenes and automations.
const ACCESSORY_REMOVAL_GRACE_MS = 5 * 60 * 1000;

type DeviceKind = 'Network' | 'Camera' | 'Doorbell' | 'Siren';

const CANONICAL_ID = /^Blink:Network:(\d+)(?::(Camera|Doorbell|Siren):(\d+))?$/;

/** The identity an accessory was registered under, if it is a current one. */
function parseCanonicalID(
  accessory: PlatformAccessory
): { kind: DeviceKind; networkID: number; id: number } | undefined {
  const canonicalID: unknown = accessory.context.canonicalID;
  const match =
    typeof canonicalID === 'string' ? CANONICAL_ID.exec(canonicalID) : null;
  if (!match) {
    return undefined;
  }
  const networkID = Number(match[1]);
  return {
    kind: (match[2] as DeviceKind | undefined) ?? 'Network',
    networkID,
    id: match[3] === undefined ? networkID : Number(match[3]),
  };
}

export class BlinkSecurityPlatform implements DynamicPlatformPlugin {
  private readonly log: Logger;
  private readonly config: BlinkOptions;
  private readonly rawConfig: BlinkSecurityConfig;
  private readonly api: API;
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private blink?: Blink;
  private authClient?: BlinkAuthClient;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private readonly pollBackoff: ExponentialBackoff;

  private securityAccessories: SecuritySystemAccessory[] = [];
  private cameraAccessories: CameraAccessory[] = [];
  private doorbellAccessories: DoorbellAccessory[] = [];
  // Retained purely so a later sync reuses the wrapper instead of rebuilding
  // it; SirenAccessory is a stateless switch with no updateState to push.
  private sirenAccessories: SirenAccessory[] = [];
  // UUIDs handed to registerPlatformAccessories, so a later sync never
  // registers the same accessory twice.
  private readonly registeredUUIDs = new Set<string>();
  // Device set seen by the last sync, to skip needless reconciles.
  private lastDeviceFingerprint = '';
  // When each cached accessory was first found removable, by UUID.
  private readonly removableSince = new Map<string, number>();
  // Accessories last reported as kept without a device, to report changes
  // only.
  private lastKept = '';

  constructor(log: Logger, config: PlatformConfig, api: API) {
    this.log = log;
    this.rawConfig = config as BlinkSecurityConfig;
    this.config = normalizeConfig(this.rawConfig);
    this.config.storagePath = api.user.storagePath();
    this.api = api;

    const blinkStatusPollingMs = this.config.blinkStatusPollingSeconds * 1000;
    this.pollBackoff = new ExponentialBackoff(
      blinkStatusPollingMs,
      Math.min(blinkStatusPollingMs * 12, 300_000),
      2
    );

    if (!this.rawConfig.username || !this.rawConfig.password) {
      this.log.error(
        'Missing Blink account credentials (username, password) in config.json'
      );
      return;
    }

    this.api.on('didFinishLaunching', () => this.init());
    this.api.on('shutdown', () => this.shutdown());
  }

  private shutdown(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    // Streams outlive the process otherwise: ffmpeg children are detached and
    // proxy servers keep holding their ports.
    for (const accessory of [
      ...this.cameraAccessories,
      ...this.doorbellAccessories,
    ]) {
      accessory.shutdown().catch(() => {
        /* best effort on the way out */
      });
    }
    this.authClient?.destroy();
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
    // Restored from Homebridge's cache means already registered; re-adding it
    // would duplicate the accessory in HomeKit.
    this.registeredUUIDs.add(accessory.UUID);
  }

  private async init(): Promise<void> {
    routineInfo(this.log, this.config, 'Initializing Blink Security');

    try {
      this.blink = await this.setupBlink();

      // Sync lv_save (Save Live View Clips) setting for each network
      for (const network of this.blink.networks.values()) {
        const current = network.data.lv_save;
        const desired = this.config.lvSave;
        routineInfo(
          this.log,
          this.config,
          `Blink ${network.name} - lv_save: ${current ?? 'unknown'} (config: ${desired})`
        );
        if (current !== undefined && current !== desired) {
          try {
            await this.blink.api.updateNetworkLvSave(network.data.id, desired);
            routineInfo(
              this.log,
              this.config,
              `Blink ${network.name} - lv_save updated to ${desired}`
            );
          } catch (e) {
            this.log.warn(
              `Blink ${network.name} - Failed to update lv_save: ${e}`
            );
          }
        }
      }

      routineInfo(
        this.log,
        this.config,
        `Blink discovered: ${this.blink.networks.size} networks, ` +
          `${this.blink.cameras.size} cameras, ` +
          `${this.blink.doorbells.size} doorbells, ` +
          `${this.blink.sirens.size} sirens`
      );

      for (const network of this.blink.networks.values()) {
        const sm = network.syncModule;
        const localStorage =
          `compatible=${sm?.local_storage_compatible ?? 'n/a'}, ` +
          `enabled=${sm?.local_storage_enabled ?? 'n/a'}, ` +
          `status=${sm?.local_storage_status ?? 'n/a'}`;
        routineInfo(
          this.log,
          this.config,
          `Blink ${network.name} - Local storage: ${localStorage} ` +
            `(motion fallback: ${this.config.localStorageMotion})`
        );
      }

      this.lastDeviceFingerprint = this.deviceFingerprint();
      this.syncAccessories();
      this.schedulePoll();
    } catch (err) {
      this.log.error(String(err));
      if (err instanceof BlinkAuth2FARequiredError) {
        this.log.error(
          'Blink devices in HomeKit will not be responsive until 2FA is completed.'
        );
        return;
      }
      // Don't retry on 2FA failures — the PIN is stale/invalid
      const errMsg = String(err);
      if (errMsg.includes('2FA') || errMsg.includes('OTP')) {
        this.log.error(
          'Blink 2FA failed. Enter a fresh PIN in the config and restart.'
        );
        return;
      }
      this.log.error('Blink initialization failed. Retrying in 30 seconds...');
      setTimeout(() => this.init(), 30000);
    }
  }

  /**
   * Reconcile HomeKit accessories against the current Blink device set.
   *
   * Runs at init and again whenever polling finds the device set changed, so
   * devices added or removed in the Blink app are picked up without a
   * restart. Accessories are built ONCE per device and reused on later
   * passes: re-constructing one would attach a second camera controller to
   * the same accessory.
   */
  private syncAccessories(): void {
    if (!this.blink) {
      return;
    }

    const active: PlatformAccessory[] = [];
    const registrations: PlatformAccessory[] = [];

    /**
     * Return the existing accessory wrapper for a device, or build and
     * register a new one.
     */
    const resolve = <T extends { platformAccessory: PlatformAccessory }>(
      existing: T | undefined,
      build: () => T
    ): T => {
      const wrapper = existing ?? build();
      const accessory = wrapper.platformAccessory;
      active.push(accessory);
      if (!existing && !this.registeredUUIDs.has(accessory.UUID)) {
        this.registeredUUIDs.add(accessory.UUID);
        registrations.push(accessory);
      }
      return wrapper;
    };

    const securityAccessories: SecuritySystemAccessory[] = [];
    if (!(this.config.noAlarm && this.config.noManualArmSwitch)) {
      for (const network of this.blink.networks.values()) {
        const existing = this.securityAccessories.find(
          a => a.platformAccessory.context.canonicalID === network.canonicalID
        );
        securityAccessories.push(
          resolve(existing, () => this.buildSecurityAccessory(network))
        );
      }
    }

    const cameraAccessories: CameraAccessory[] = [];
    if (!this.config.noCameras) {
      for (const camera of this.blink.cameras.values()) {
        const existing = this.cameraAccessories.find(
          a => a.platformAccessory.context.canonicalID === camera.canonicalID
        );
        cameraAccessories.push(
          resolve(existing, () => this.buildCameraAccessory(camera))
        );
      }
    }

    const doorbellAccessories: DoorbellAccessory[] = [];
    if (!this.config.noDoorbells) {
      for (const doorbell of this.blink.doorbells.values()) {
        const existing = this.doorbellAccessories.find(
          a => a.platformAccessory.context.canonicalID === doorbell.canonicalID
        );
        doorbellAccessories.push(
          resolve(existing, () => this.buildDoorbellAccessory(doorbell))
        );
      }
    }

    const sirenAccessories: SirenAccessory[] = [];
    for (const siren of this.blink.sirens.values()) {
      const existing = this.sirenAccessories.find(
        a => a.platformAccessory.context.canonicalID === siren.canonicalID
      );
      sirenAccessories.push(
        resolve(existing, () => this.buildSirenAccessory(siren))
      );
    }

    // Capture the wrappers being dropped before the arrays are replaced:
    // they own ffmpeg children and proxy servers that must be released.
    const retained = new Set(active);
    const dropped = [
      ...this.cameraAccessories,
      ...this.doorbellAccessories,
    ].filter(a => !retained.has(a.platformAccessory));

    this.securityAccessories = securityAccessories;
    this.cameraAccessories = cameraAccessories;
    this.doorbellAccessories = doorbellAccessories;
    this.sirenAccessories = sirenAccessories;

    for (const wrapper of dropped) {
      wrapper
        .shutdown()
        .catch(err => this.log.debug(`Accessory teardown failed: ${err}`));
    }

    const activeUUIDs = new Set(active.map(a => a.UUID));
    const stale = this.staleAccessories(active, activeUUIDs);

    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(
        `Unregistering ${stale.length} stale accessories: ` +
          stale.map(a => a.displayName).join(', ')
      );
      for (const accessory of stale) {
        this.removableSince.delete(accessory.UUID);
        this.registeredUUIDs.delete(accessory.UUID);
        const index = this.cachedAccessories.indexOf(accessory);
        if (index >= 0) {
          this.cachedAccessories.splice(index, 1);
        }
      }
    }

    if (registrations.length > 0) {
      this.log.info(
        `Registering ${registrations.length} new accessories: ` +
          registrations.map(a => a.displayName).join(', ')
      );
      this.api.registerPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        registrations
      );
      // Keep the cache authoritative so a later pass sees these as known.
      this.cachedAccessories.push(...registrations);
    }

    routineInfo(
      this.log,
      this.config,
      `Blink ready: ${active.length} total accessories ` +
        `(${registrations.length} new, ${stale.length} stale removed, ` +
        `${this.cachedAccessories.length} cached)`
    );
  }

  /**
   * Cached accessories to unregister on this pass.
   *
   * Unregistering takes the user's room assignments, names, scenes and
   * automations with it and nothing restores them, so an accessory that
   * merely has no device right now is kept. It is removed when the user
   * hid its kind, or when Blink keeps reporting other devices of that kind
   * without it for the whole grace period. A kind Blink reports none of is
   * far more likely a partial response than a mass deletion, at startup as
   * much as mid-session.
   */
  private staleAccessories(
    active: PlatformAccessory[],
    activeUUIDs: Set<string>
  ): PlatformAccessory[] {
    const reportedKinds = new Set(active.map(a => parseCanonicalID(a)?.kind));
    const now = Date.now();
    const stale: PlatformAccessory[] = [];
    const kept: PlatformAccessory[] = [];

    for (const accessory of this.cachedAccessories) {
      if (activeUUIDs.has(accessory.UUID)) {
        this.removableSince.delete(accessory.UUID);
        continue;
      }
      const kind = parseCanonicalID(accessory)?.kind;
      // No current identity means no device can ever claim it again.
      if (!kind || this.isHidden(kind)) {
        stale.push(accessory);
        continue;
      }
      const removable =
        reportedKinds.has(kind) &&
        !this.blink?.unresolvedDevices.has(accessory.context.canonicalID);
      if (!removable) {
        this.removableSince.delete(accessory.UUID);
        kept.push(accessory);
        continue;
      }
      const since = this.removableSince.get(accessory.UUID) ?? now;
      this.removableSince.set(accessory.UUID, since);
      if (now - since >= ACCESSORY_REMOVAL_GRACE_MS) {
        stale.push(accessory);
      }
    }

    const keptNames = kept.map(a => a.displayName).join(', ');
    if (keptNames !== this.lastKept) {
      this.lastKept = keptNames;
      if (kept.length > 0) {
        this.log.warn(
          `Blink did not account for ${kept.length} existing accessories; ` +
            `keeping them rather than removing them: ${keptNames}. If these ` +
            'devices were removed from the Blink account, remove them from ' +
            'the Homebridge accessory cache.'
        );
      }
    }
    return stale;
  }

  /** Whether the user's config keeps this kind of device out of HomeKit. */
  private isHidden(kind: DeviceKind): boolean {
    switch (kind) {
      case 'Camera':
        return this.config.noCameras;
      case 'Doorbell':
        return this.config.noDoorbells;
      case 'Network':
        return this.config.noAlarm && this.config.noManualArmSwitch;
      case 'Siren':
        return false;
    }
  }

  /** Whether an accessory has now been removable for the grace period. */
  private removalDue(): boolean {
    const now = Date.now();
    return [...this.removableSince.values()].some(
      since => now - since >= ACCESSORY_REMOVAL_GRACE_MS
    );
  }

  /**
   * Doorbells already in the accessory cache. The device layer asks Blink
   * about these by ID, so keeping one never depends on it having a recent
   * clip when Homebridge starts.
   */
  private cachedDoorbells(): CachedDoorbell[] {
    const doorbells: CachedDoorbell[] = [];
    for (const accessory of this.cachedAccessories) {
      const identity = parseCanonicalID(accessory);
      if (identity?.kind === 'Doorbell') {
        doorbells.push({
          id: identity.id,
          networkID: identity.networkID,
          canonicalID: accessory.context.canonicalID,
          displayName: accessory.displayName,
        });
      }
    }
    return doorbells;
  }

  /* Accessory construction is isolated behind these hooks so the reconcile
   * logic can be exercised without a full HAP implementation. */
  protected buildSecurityAccessory(
    network: BlinkNetwork
  ): SecuritySystemAccessory {
    return new SecuritySystemAccessory(
      network,
      this.api,
      this.log,
      this.config,
      this.cachedAccessories
    );
  }

  protected buildCameraAccessory(camera: BlinkCamera): CameraAccessory {
    return new CameraAccessory(
      camera,
      this.api,
      this.log,
      this.config,
      this.cachedAccessories
    );
  }

  protected buildDoorbellAccessory(doorbell: BlinkDoorbell): DoorbellAccessory {
    return new DoorbellAccessory(
      doorbell,
      this.api,
      this.log,
      this.config,
      this.cachedAccessories
    );
  }

  protected buildSirenAccessory(siren: BlinkSiren): SirenAccessory {
    return new SirenAccessory(
      siren,
      this.api,
      this.log,
      this.config,
      this.cachedAccessories
    );
  }

  /** Canonical IDs of every device currently exposed, for change detection. */
  private deviceFingerprint(): string {
    if (!this.blink) {
      return '';
    }
    return [
      ...[...this.blink.networks.values()].map(n => n.canonicalID),
      ...[...this.blink.cameras.values()].map(c => c.canonicalID),
      ...[...this.blink.doorbells.values()].map(d => d.canonicalID),
      ...[...this.blink.sirens.values()].map(s => s.canonicalID),
      // A cached device gaining or losing its verdict changes what may be
      // unregistered, without changing the device set.
      ...[...this.blink.unresolvedDevices].map(id => `unresolved:${id}`),
    ]
      .sort()
      .join('|');
  }

  private schedulePoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    const delayMs = this.pollBackoff.delayMs;
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    try {
      // Bounded because the loop re-arms only after this settles: refreshData
      // awaits the media list through pollLocalStorage, and a hung request
      // there would otherwise stop every poll until the socket timed out.
      const refresh = this.blink?.refreshData();
      if (refresh) {
        await withTimeout(refresh, POLL_CYCLE_TIMEOUT_MS, 'Poll cycle');
      }
      this.pollBackoff.reset();
      // Devices added or removed in the Blink app reach HomeKit here; the
      // fingerprint keeps the common no-change case free.
      const fingerprint = this.deviceFingerprint();
      if (fingerprint !== this.lastDeviceFingerprint || this.removalDue()) {
        this.lastDeviceFingerprint = fingerprint;
        this.syncAccessories();
      }
    } catch (err) {
      this.log.error(String(err));
      this.pollBackoff.increment();
    } finally {
      // In a finally so the loop re-arms on every path: a throw here would
      // otherwise end polling for good, since nothing else reschedules it.
      this.pushUpdates();
      this.schedulePoll();
    }
  }

  private pushUpdates(): void {
    for (const sa of this.securityAccessories) {
      sa.updateState();
    }
    for (const ca of this.cameraAccessories) {
      ca.updateState();
    }
    for (const da of this.doorbellAccessories) {
      da.updateState();
    }
  }

  private async setupBlink(): Promise<Blink> {
    if (!this.rawConfig.username || !this.rawConfig.password) {
      throw new Error('Missing Blink credentials in config.json');
    }

    const authClient = new BlinkAuthClient(this.config.storagePath);
    this.authClient = authClient;

    // Try to use existing session
    if (authClient.isAuthenticated) {
      routineInfo(
        this.log,
        this.config,
        'Blink: Restored authenticated session'
      );
    } else if (authClient.state === 'TOKEN_EXPIRED') {
      // Token expired — try refresh
      routineInfo(
        this.log,
        this.config,
        'Blink: Session expired, refreshing token...'
      );
      try {
        await authClient.refreshTokens();
        routineInfo(
          this.log,
          this.config,
          'Blink: Token refreshed successfully'
        );
      } catch {
        this.log.warn('Blink: Token refresh failed, re-authenticating...');
        await this.performAuth(authClient);
      }
    } else if (authClient.state === 'AWAITING_2FA' && this.config.pin) {
      // Run full auth + 2FA in a single session (session can't survive restarts)
      routineInfo(
        this.log,
        this.config,
        'Blink: Running full auth + 2FA flow...'
      );
      try {
        await authClient.authenticateWith2FA(
          this.rawConfig.username,
          this.rawConfig.password,
          this.config.pin
        );
        routineInfo(
          this.log,
          this.config,
          'Blink: Authentication + 2FA verification successful'
        );
      } catch (e) {
        this.log.error(String(e));
        throw new Error(
          'Blink 2FA verification failed. Check your PIN and restart.',
          { cause: e }
        );
      }
    } else {
      // Fresh authentication
      await this.performAuth(authClient);
    }

    const blink = new Blink(
      authClient,
      this.log,
      this.config.statusPollingSeconds,
      this.config.motionPollingSeconds,
      this.config.snapshotSeconds,
      this.config
    );

    if (!this.config.noDoorbells) {
      blink.seedCachedDoorbells(this.cachedDoorbells());
    }
    await blink.refreshData();
    return blink;
  }

  private async performAuth(authClient: BlinkAuthClient): Promise<void> {
    try {
      await authClient.authenticate(
        this.rawConfig.username,
        this.rawConfig.password
      );
      routineInfo(this.log, this.config, 'Blink: Authentication successful');
    } catch (e) {
      if (e instanceof BlinkAuth2FARequiredError) {
        this.log.warn(
          'Blink: 2FA verification required. Enter your verification code in the plugin config "pin" field and restart Homebridge.'
        );
      }
      throw e;
    }
  }
}
