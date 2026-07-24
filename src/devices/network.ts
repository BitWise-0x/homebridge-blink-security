import {
  BlinkDevice,
  type BlinkDeviceContext,
  type HomescreenNetwork,
  type SyncModule,
} from './base.js';
import type { Blink } from './index.js';

export interface NetworkData extends HomescreenNetwork {
  syncModule?: SyncModule;
}

export class BlinkNetwork extends BlinkDevice {
  readonly id: number;
  blink: Blink;
  private _commandID?: number;

  constructor(data: NetworkData, blink: Blink) {
    super(data);
    this.id = data.id;
    this.blink = blink;
  }

  override get canonicalID(): string {
    return `Blink:Network:${this.networkID}`;
  }

  override get data(): NetworkData {
    return (this._context.data ?? this._data) as NetworkData;
  }

  override set data(newInfo: NetworkData) {
    // Arm state also changes outside HomeKit (Blink app, schedules), so
    // transitions are stamped here as well as in setArmedState. The motion
    // gate needs both bounds of the armed interval regardless of which side
    // initiated the change.
    const wasArmed = Boolean(
      ((this._context.data ?? this._data) as NetworkData | undefined)?.armed
    );
    const isArmed = Boolean(newInfo.armed);
    if (isArmed && !wasArmed) {
      this.armedAt = Date.now();
    } else if (!isArmed && wasArmed) {
      this.disarmedAt = Date.now();
    }
    this._data = newInfo;
    if (this._context) {
      this._context.data = this._data;
    }
  }

  get syncModule(): SyncModule | undefined {
    return this.data.syncModule;
  }

  override get serial(): string | undefined {
    return this.syncModule?.serial;
  }

  override get firmware(): string | undefined {
    return this.syncModule?.fw_version;
  }

  override get model(): string | undefined {
    return this.syncModule?.type;
  }

  get status(): string | undefined {
    return (this.data as NetworkData).status ?? this.syncModule?.status;
  }

  get online(): boolean {
    return this.status === 'online';
  }

  get armed(): boolean {
    return Boolean(this.data.armed);
  }

  get armedAt(): number {
    return (this.context as BlinkDeviceContext).armedAt ?? 0;
  }

  set armedAt(val: number) {
    (this.context as BlinkDeviceContext).armedAt = val;
  }

  get disarmedAt(): number {
    return (this.context as BlinkDeviceContext).disarmedAt ?? 0;
  }

  set disarmedAt(val: number) {
    (this.context as BlinkDeviceContext).disarmedAt = val;
  }

  get cameras() {
    return [...this.blink.cameras.values()].filter(
      c => c.networkID === this.networkID
    );
  }

  get commandID(): number | undefined {
    return this._commandID;
  }

  set commandID(val: number | undefined) {
    this._commandID = val;
  }

  async setArmedState(target: boolean): Promise<void> {
    if (this.armed !== target) {
      if (target) {
        this.armedAt = Date.now();
      } else {
        this.disarmedAt = Date.now();
      }
      await this.blink.setArmedState(this.networkID, target);
    }
  }
}
