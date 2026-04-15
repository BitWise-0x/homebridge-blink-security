import {
  API,
  Characteristic,
  Logger,
  PlatformAccessory,
  type Service,
} from 'homebridge';

import type { BlinkSiren } from '../devices/siren.js';

export class SirenAccessory {
  private readonly accessory: PlatformAccessory;
  private readonly siren: BlinkSiren;
  private readonly log: Logger;
  private readonly Characteristic: typeof Characteristic;
  private readonly Service: typeof Service;

  constructor(
    siren: BlinkSiren,
    api: API,
    log: Logger,
    cachedAccessories: PlatformAccessory[]
  ) {
    this.siren = siren;
    this.log = log;
    this.Characteristic = api.hap.Characteristic;
    this.Service = api.hap.Service;

    const uuid = api.hap.uuid.generate(siren.canonicalID);
    const existingAccessory = cachedAccessories.find(a => a.UUID === uuid);

    if (existingAccessory) {
      this.accessory = existingAccessory;
    } else {
      this.accessory = new api.platformAccessory(`Blink ${siren.name}`, uuid);
    }

    this.accessory.context.canonicalID = siren.canonicalID;

    const existingContext = cachedAccessories
      .map(a => a.context)
      .find(c => c.canonicalID === siren.canonicalID);
    if (existingContext) {
      Object.assign(this.accessory.context, existingContext);
    }

    this.setupAccessoryInfo();
    this.setupSirenSwitch();
  }

  get platformAccessory(): PlatformAccessory {
    return this.accessory;
  }

  private setupAccessoryInfo(): void {
    const infoService = this.accessory.getService(
      this.Service.AccessoryInformation
    );
    if (!infoService) {
      return;
    }

    infoService
      .setCharacteristic(this.Characteristic.Name, this.siren.name)
      .setCharacteristic(this.Characteristic.Manufacturer, 'Blink');

    if (this.siren.firmware) {
      infoService.setCharacteristic(
        this.Characteristic.FirmwareRevision,
        this.siren.firmware
      );
    }
    if (this.siren.model) {
      infoService.setCharacteristic(
        this.Characteristic.Model,
        this.siren.model
      );
    }
    if (this.siren.serial) {
      infoService.setCharacteristic(
        this.Characteristic.SerialNumber,
        this.siren.serial
      );
    }
  }

  private setupSirenSwitch(): void {
    const name = `${this.siren.name} Siren`;
    const service =
      this.accessory.getService(this.Service.Switch) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        `siren.${this.siren.serial}`
      );

    service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
    service.setCharacteristic(this.Characteristic.ConfiguredName, name);

    // Blink API has no endpoint to query active siren state
    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet(async value => {
        if (value) {
          this.log.info(`${this.siren.name}: Activating siren`);
          await this.siren.activate();
        } else {
          this.log.info(`${this.siren.name}: Deactivating siren`);
          await this.siren.deactivate();
        }
      });
  }
}
