import type {
  HomescreenNetwork,
  HomescreenCamera,
  SyncModule,
} from '../lib/api.js';

export type BlinkDeviceData = HomescreenNetwork | HomescreenCamera;

export interface BlinkDeviceContext {
  canonicalID?: string;
  data?: BlinkDeviceData;
  armedAt?: number;
  _privacy?: boolean;
  _nightVision?: boolean;
  armed?: number;
  lastDoorbellPress?: number;
}

export class BlinkDevice {
  protected _data: BlinkDeviceData;
  protected _prefix = 'Blink ';
  protected _context: BlinkDeviceContext = {};

  constructor(data: BlinkDeviceData) {
    this._data = data;
  }

  get canonicalID(): string {
    return `Blink:Device:${this.networkID}`;
  }

  get networkID(): number {
    return (
      (this.data as HomescreenCamera).network_id ??
      (this.data as HomescreenNetwork).id
    );
  }

  get name(): string {
    return `${this._prefix}${this.data?.name}`;
  }

  get serial(): string | undefined {
    return (this.data as HomescreenCamera).serial;
  }

  get firmware(): string | undefined {
    return (this.data as HomescreenCamera).fw_version;
  }

  get model(): string | undefined {
    return (this.data as HomescreenCamera).type;
  }

  get updatedAt(): number {
    return Date.parse(this.data.updated_at) || 0;
  }

  get context(): BlinkDeviceContext {
    return this._context;
  }

  set context(val: BlinkDeviceContext) {
    this._context = val;
  }

  get data(): BlinkDeviceData {
    return this._context.data ?? this._data;
  }

  set data(newInfo: BlinkDeviceData) {
    this._data = newInfo;
    if (this._context) {
      this._context.data = this._data;
    }
  }
}

export { SyncModule, HomescreenNetwork, HomescreenCamera };
