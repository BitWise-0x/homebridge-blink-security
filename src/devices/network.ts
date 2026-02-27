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
      }
      await this.blink.setArmedState(this.networkID, target);
    }
  }
}
