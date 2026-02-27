import type { HomescreenSiren } from '../lib/api.js';
import type { Blink } from './index.js';

export class BlinkSiren {
  readonly id: number;
  readonly blink: Blink;
  private _data: HomescreenSiren;

  constructor(data: HomescreenSiren, blink: Blink) {
    this._data = data;
    this.id = data.id;
    this.blink = blink;
  }

  get data(): HomescreenSiren {
    return this._data;
  }

  set data(newInfo: HomescreenSiren) {
    this._data = newInfo;
  }

  get canonicalID(): string {
    return `Blink:Network:${this.networkID}:Siren:${this.id}`;
  }

  get networkID(): number {
    return this._data.network_id;
  }

  get name(): string {
    return this._data.name;
  }

  get serial(): string | undefined {
    return this._data.serial;
  }

  get firmware(): string | undefined {
    return this._data.fw_version;
  }

  get model(): string | undefined {
    return this._data.type;
  }

  get online(): boolean {
    return this._data.status === 'online';
  }

  get enabled(): boolean {
    return Boolean(this._data.enabled);
  }

  async activate(durationSeconds = 30): Promise<void> {
    await this.blink.activateSiren(this.networkID, this.id, durationSeconds);
  }

  async deactivate(): Promise<void> {
    await this.blink.deactivateSirens(this.networkID);
  }
}
