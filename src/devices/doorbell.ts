import { BlinkCamera } from './camera.js';
import type { HomescreenCamera } from './base.js';
import { type Blink, MOTION_TRIGGER_DECAY } from './index.js';

const DOORBELL_PRESS_DECAY_MS = 30_000;

export type DoorbellPressCallback = (doorbell: BlinkDoorbell) => void;

export class BlinkDoorbell extends BlinkCamera {
  private _onPress?: DoorbellPressCallback;
  private readonly _initTime = Date.now();

  constructor(data: HomescreenCamera, blink: Blink) {
    super(data, blink);
  }

  override get canonicalID(): string {
    return `Blink:Network:${this.networkID}:Doorbell:${this.cameraID}`;
  }

  get isDoorbell(): boolean {
    return true;
  }

  override get isCameraMini(): boolean {
    return false;
  }

  get lastDoorbellPress(): number {
    return this._context.lastDoorbellPress ?? this._initTime;
  }

  set lastDoorbellPress(val: number) {
    this._context.lastDoorbellPress = val;
  }

  get doorbellPressed(): boolean {
    if (this.lastDoorbellPress <= 0) {
      return false;
    }
    return Date.now() - this.lastDoorbellPress < DOORBELL_PRESS_DECAY_MS;
  }

  set onPress(cb: DoorbellPressCallback | undefined) {
    this._onPress = cb;
  }

  async checkForPress(): Promise<boolean> {
    const lastMotion = await this.blink
      .getCameraLastMotion(this.networkID, this.cameraID)
      .catch(() => undefined);
    if (!lastMotion) {
      return false;
    }

    // If the API provides a source field, only treat "button" as a press.
    // Other sources (e.g. "pir", liveview) are not doorbell presses.
    if (lastMotion.source && lastMotion.source !== 'button') {
      return false;
    }

    const eventTime = Date.parse(lastMotion.created_at) || 0;
    if (eventTime <= 0) {
      return false;
    }

    if (eventTime > this.lastDoorbellPress) {
      const age = Date.now() - eventTime;
      if (age < MOTION_TRIGGER_DECAY * 1000) {
        this.lastDoorbellPress = eventTime;
        this._onPress?.(this);
        return true;
      }
    }

    return false;
  }

  override async setEnabled(target = true): Promise<void> {
    if (this.enabled !== Boolean(target)) {
      await this.blink.setDoorbellMotionSensorState(
        this.networkID,
        this.cameraID,
        target
      );
    }
  }

  async getLiveViewURL(timeout = 30): Promise<string | undefined> {
    const data = await this.blink.getDoorbellLiveView(
      this.networkID,
      this.cameraID,
      timeout
    );
    return data?.server;
  }

  async refreshThumbnail(force = false): Promise<void> {
    await this.blink.refreshDoorbellThumbnail(
      this.networkID,
      this.cameraID,
      force
    );
  }
}
