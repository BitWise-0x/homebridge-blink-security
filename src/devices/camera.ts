import { BlinkDevice, type HomescreenCamera } from './base.js';
import type { BlinkNetwork } from './network.js';
import { type Blink, ARMED_DELAY, MOTION_TRIGGER_DECAY } from './index.js';
import { fahrenheitToCelsius } from '../lib/utils.js';

// Owl-family device codenames we have seen in the field (owl=Mini,
// hawk=Mini 2, superior=Wired Floodlight, chickadee=Mini 2K+). This list is
// DIAGNOSTIC ONLY and must never influence routing: Amazon assigns a new
// bird codename per hardware revision, so matching on it breaks for every
// new model (issues #40, #51). The authoritative signal is membership in
// the homescreen `owls` array — see `isOwlDevice`.
export const KNOWN_OWL_CODENAMES = ['owl', 'hawk', 'superior', 'chickadee'];

export class BlinkCamera extends BlinkDevice {
  readonly id: number;
  blink: Blink;
  // True when this device was found in the homescreen `owls` array. This is
  // the reliable discriminator for routing through the owl endpoint family,
  // regardless of what codename it reports.
  readonly isOwlDevice: boolean;
  private cacheThumbnail = new Map<string, Buffer>();

  constructor(data: HomescreenCamera, blink: Blink, isOwlDevice = false) {
    super(data);
    this.id = data.id;
    this.blink = blink;
    this.isOwlDevice = isOwlDevice;
  }

  override get data(): HomescreenCamera {
    return (this._context.data ?? this._data) as HomescreenCamera;
  }

  override set data(newInfo: HomescreenCamera) {
    this._data = newInfo;
    if (this._context) {
      this._context.data = this._data;
    }
  }

  get cameraID(): number {
    return this.data.id;
  }

  override get canonicalID(): string {
    return `Blink:Network:${this.networkID}:Camera:${this.cameraID}`;
  }

  get status(): string | undefined {
    return this.data.status && this.data.status !== 'done'
      ? this.data.status
      : this.network?.status;
  }

  get online(): boolean {
    return (
      ['online', 'done'].includes(this.data.status) &&
      (this.isCameraMini || (this.network?.online ?? false))
    );
  }

  get armed(): boolean {
    return this.network?.armed ?? false;
  }

  get enabled(): boolean {
    return Boolean(this.data.enabled);
  }

  get thumbnail(): string {
    return this.data.thumbnail;
  }

  get network(): BlinkNetwork | undefined {
    return this.blink.networks.get(this.networkID);
  }

  get privacyMode(): boolean {
    return Boolean(this._context._privacy);
  }

  set privacyMode(val: boolean) {
    this._context._privacy = val;
  }

  get thumbnailCreatedAt(): number {
    const data = this.data as HomescreenCamera & {
      thumbnail_created_at?: number;
    };
    if (data.thumbnail_created_at) {
      return data.thumbnail_created_at;
    }

    const dateRegex =
      /(\d{4})_(\d\d)_(\d\d)__(\d\d)_(\d\d)(?:am|pm)?$|[?&]ts=(\d+)(?:&|$)/i;
    const match = dateRegex.exec(this.thumbnail);
    if (!match) {
      this.thumbnailCreatedAt = Date.now();
      return data.thumbnail_created_at!;
    }

    const [, year, month, day, hour, minute, epoch] = match;
    if (epoch) {
      this.thumbnailCreatedAt = Date.parse(
        new Date(Number(epoch.padEnd(13, '0'))).toISOString()
      );
    } else {
      this.thumbnailCreatedAt =
        Date.parse(`${year}-${month}-${day} ${hour}:${minute} +000`) ||
        Date.now();
    }
    return data.thumbnail_created_at!;
  }

  set thumbnailCreatedAt(val: number) {
    (
      this.data as HomescreenCamera & { thumbnail_created_at?: number }
    ).thumbnail_created_at = val;
  }

  get isBatteryPower(): boolean {
    return this.data.battery !== undefined;
  }

  get lowBattery(): boolean | null {
    return this.isBatteryPower ? this.data.battery === 'low' : null;
  }

  get batteryLevel(): number | null {
    if (!this.isBatteryPower) {
      return null;
    }
    const voltage = this.data.signals?.battery;
    if (voltage === undefined || voltage === null) {
      return null;
    }
    // Blink battery voltage range: ~2.4V (empty) to ~3.0V (full)
    const minVoltage = 2.4;
    const maxVoltage = 3.0;
    const level = ((voltage - minVoltage) / (maxVoltage - minVoltage)) * 100;
    return Math.max(0, Math.min(100, Math.round(level)));
  }

  get isCameraMini(): boolean {
    return this.isOwlDevice;
  }

  get temperature(): number | null {
    return fahrenheitToCelsius(this.data.signals?.temp ?? 0) || null;
  }

  async getMotionDetected(): Promise<boolean> {
    if (!this.armed) {
      return false;
    }

    // Local-storage clips don't bump the homescreen updated_at, so their
    // timestamp participates in the staleness gate directly.
    const lastDeviceUpdate =
      Math.max(
        this.updatedAt,
        this.network?.updatedAt ?? 0,
        this.blink.getLocalMediaTimestamp(this.cameraID)
      ) +
      MOTION_TRIGGER_DECAY * 1000;
    if (Date.now() > lastDeviceUpdate) {
      return false;
    }

    const lastMotion = await this.blink.getCameraLastMotion(
      this.networkID,
      this.cameraID
    );
    if (!lastMotion) {
      return false;
    }

    // Local-storage clips use their discovery time for freshness: created_at
    // is the recording start and may already be outside the decay window by
    // the time the manifest surfaces the clip.
    const eventAt = Math.max(
      Date.parse(lastMotion.created_at) || 0,
      this.blink.getLocalMediaTimestamp(this.cameraID)
    );
    const triggerEnd = eventAt + MOTION_TRIGGER_DECAY * 1000;

    // Events that predate arming are history and must not fire. The
    // comparison is against the EVENT time, not the current time — gating on
    // Date.now() is always satisfied once armed and suppresses nothing.
    // ARMED_DELAY grants a grace window backwards from the arm instant so a
    // clip recorded moments before the arm command completed still counts.
    // This is deliberately the opposite direction from securitySystem's
    // alarm gate, which waits ARMED_DELAY *after* arming to swallow the
    // spurious event Blink emits on arm: suppressing an alarm is cheap,
    // suppressing a motion notification loses it entirely.
    const armedAt = this.network?.armedAt || 0;
    const triggerStart = armedAt > 0 ? armedAt - ARMED_DELAY * 1000 : 0;

    return eventAt >= triggerStart && Date.now() <= triggerEnd;
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  async setEnabled(target = true): Promise<void> {
    if (this.enabled !== Boolean(target)) {
      await this.blink.setCameraMotionSensorState(
        this.networkID,
        this.cameraID,
        target
      );
    }
  }

  get nightVision(): boolean {
    return this._context._nightVision ?? true;
  }

  set nightVision(val: boolean) {
    this._context._nightVision = val;
  }

  async setNightVision(enabled: boolean): Promise<void> {
    if (this.isCameraMini) {
      return;
    }
    await this.blink.updateCameraSettings(this.networkID, this.cameraID, {
      illuminator_enable: enabled ? 1 : 0,
    });
    this.nightVision = enabled;
  }

  async recordClip(): Promise<void> {
    await this.blink.recordCameraClip(this.networkID, this.cameraID);
  }

  async refreshThumbnail(force = false): Promise<void> {
    await this.blink.refreshCameraThumbnail(
      this.networkID,
      this.cameraID,
      force
    );
  }

  async getThumbnail(includeMotion = false): Promise<Buffer | undefined> {
    if (this.privacyMode) {
      this.blink.log.debug(`${this.name} - Thumbnail skipped: privacy mode`);
      return undefined;
    }

    let thumbnailUrl = this.thumbnail;
    if (!thumbnailUrl) {
      this.blink.log.debug(`${this.name} - Thumbnail skipped: no URL`);
      return undefined;
    }

    if (includeMotion) {
      const url = await this.blink.getCameraLastThumbnail(
        this.networkID,
        this.cameraID
      );
      if (url) {
        thumbnailUrl = url;
      }
    }

    if (this.cacheThumbnail.has(thumbnailUrl)) {
      const cached = this.cacheThumbnail.get(thumbnailUrl)!;
      this.blink.log.debug(
        `${this.name} - Thumbnail cache hit: ${cached.length} bytes`
      );
      return cached;
    }

    this.blink.log.debug(`${this.name} - Thumbnail fetch: ${thumbnailUrl}`);
    let data: Buffer;
    try {
      data = await this.blink.api.getBinary(thumbnailUrl);
    } catch {
      // Thumbnail URL is stale (404) — clear it so the next poll can provide a fresh one
      if (this.data.thumbnail === thumbnailUrl) {
        (this.data as HomescreenCamera).thumbnail = '';
      }
      return undefined;
    }
    // Only cache non-empty results — 0-byte responses should be retried
    if (data.length > 0) {
      this.cacheThumbnail.clear();
      this.cacheThumbnail.set(thumbnailUrl, data);
    } else {
      this.blink.log.debug(
        `${this.name} - Thumbnail returned 0 bytes, not caching`
      );
    }
    return data;
  }

  clearThumbnailCache(): void {
    this.cacheThumbnail.clear();
  }

  async getLiveViewURL(timeout = 30): Promise<string | undefined> {
    const data = await this.blink.getCameraLiveView(
      this.networkID,
      this.cameraID,
      timeout
    );
    this.blink.log.debug(
      `${this.name} - LiveView response: server=${data?.server ?? 'none'}, id=${data?.id ?? data?.command_id ?? 'none'}`
    );
    return data?.server;
  }
}
