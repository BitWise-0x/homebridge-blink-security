import { BlinkDevice, type HomescreenCamera } from './base.js';
import type { BlinkNetwork } from './network.js';
import { type Blink, ARMED_DELAY, MOTION_TRIGGER_DECAY } from './index.js';
import { fahrenheitToCelsius } from '../lib/utils.js';

export class BlinkCamera extends BlinkDevice {
  readonly id: number;
  blink: Blink;
  private cacheThumbnail = new Map<string, Buffer>();

  constructor(data: HomescreenCamera, blink: Blink) {
    super(data);
    this.id = data.id;
    this.blink = blink;
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
    return ['owl', 'hawk', 'superior_owl'].includes(this.model ?? '');
  }

  get isHawk(): boolean {
    return this.model === 'hawk';
  }

  get isFloodlight(): boolean {
    return this.model === 'superior_owl';
  }

  get temperature(): number | null {
    return fahrenheitToCelsius(this.data.signals?.temp ?? 0) || null;
  }

  async getMotionDetected(): Promise<boolean> {
    if (!this.armed) {
      return false;
    }

    const lastDeviceUpdate =
      Math.max(this.updatedAt, this.network?.updatedAt ?? 0) +
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

    const triggerEnd =
      (Date.parse(lastMotion.created_at) || 0) + MOTION_TRIGGER_DECAY * 1000;
    const triggerStart =
      (this.network?.armedAt ?? this.network?.updatedAt ?? 0) -
      ARMED_DELAY * 1000;

    return Date.now() >= triggerStart && Date.now() <= triggerEnd;
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
