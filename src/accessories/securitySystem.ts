import {
  API,
  Categories,
  Characteristic,
  Logger,
  PlatformAccessory,
  type Service,
} from 'homebridge';

import type { BlinkNetwork } from '../devices/network.js';
import { ARMED_DELAY } from '../devices/index.js';
import type { BlinkOptions } from '../lib/config.js';

export class SecuritySystemAccessory {
  private readonly accessory: PlatformAccessory;
  private readonly network: BlinkNetwork;
  private readonly log: Logger;
  private readonly config: BlinkOptions;
  private readonly Characteristic: typeof Characteristic;
  private readonly Service: typeof Service;
  private securityService?: Service;
  private armSwitchService?: Service;

  constructor(
    network: BlinkNetwork,
    api: API,
    log: Logger,
    config: BlinkOptions,
    cachedAccessories: PlatformAccessory[]
  ) {
    this.network = network;
    this.log = log;
    this.config = config;
    this.Characteristic = api.hap.Characteristic;
    this.Service = api.hap.Service;

    const uuid = api.hap.uuid.generate(network.canonicalID);
    const existingAccessory = cachedAccessories.find(a => a.UUID === uuid);

    if (existingAccessory) {
      this.accessory = existingAccessory;
    } else {
      this.accessory = new api.platformAccessory(
        `Blink ${network.name}`,
        uuid,
        Categories.SECURITY_SYSTEM
      );
    }

    this.accessory.context.canonicalID = network.canonicalID;

    const existingContext = cachedAccessories
      .map(a => a.context)
      .find(c => c.canonicalID === network.canonicalID);
    if (existingContext) {
      Object.assign(this.accessory.context, existingContext);
    }
    network.context = this.accessory.context;

    this.setupAccessoryInfo();

    if (!config.noAlarm) {
      this.setupSecuritySystem();
    }

    if (!config.noManualArmSwitch) {
      this.setupArmSwitch();
    }

    this.cleanupStaleServices();
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
      .setCharacteristic(this.Characteristic.Name, this.network.name)
      .setCharacteristic(this.Characteristic.Manufacturer, 'Blink');

    if (this.network.firmware) {
      infoService.setCharacteristic(
        this.Characteristic.FirmwareRevision,
        this.network.firmware
      );
    }
    if (this.network.model) {
      infoService.setCharacteristic(
        this.Characteristic.Model,
        this.network.model
      );
    }
    if (this.network.serial) {
      infoService.setCharacteristic(
        this.Characteristic.SerialNumber,
        this.network.serial
      );
    }
  }

  private setupSecuritySystem(): void {
    this.securityService =
      this.accessory.getService(this.Service.SecuritySystem) ||
      this.accessory.addService(this.Service.SecuritySystem);

    this.securityService
      .getCharacteristic(this.Characteristic.SecuritySystemCurrentState)
      .onGet(async () => this.getCurrentState());

    this.securityService
      .getCharacteristic(this.Characteristic.SecuritySystemTargetState)
      .onGet(() => this.getTargetState())
      .onSet(async value => {
        await this.setTargetState(value as number);
      });

    const validValues = [
      this.Characteristic.SecuritySystemTargetState.STAY_ARM,
      this.Characteristic.SecuritySystemTargetState.AWAY_ARM,
      this.Characteristic.SecuritySystemTargetState.NIGHT_ARM,
      this.Characteristic.SecuritySystemTargetState.DISARM,
    ];
    this.securityService
      .getCharacteristic(this.Characteristic.SecuritySystemTargetState)
      .setProps({ validValues });
  }

  private setupArmSwitch(): void {
    const name = `${this.network.name} Arm`;
    this.armSwitchService =
      this.accessory.getService(`armed.${this.network.serial}`) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        `armed.${this.network.serial}`
      );

    this.armSwitchService.addOptionalCharacteristic(
      this.Characteristic.ConfiguredName
    );
    this.armSwitchService.setCharacteristic(
      this.Characteristic.ConfiguredName,
      name
    );

    this.armSwitchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.network.armed)
      .onSet(async value => {
        const targetState = value
          ? this.Characteristic.SecuritySystemTargetState.AWAY_ARM
          : this.Characteristic.SecuritySystemTargetState.DISARM;
        await this.setTargetState(targetState);
      });
  }

  private async getCurrentState(): Promise<number> {
    const currentState = this.getSecurityState();
    if (
      currentState !== this.Characteristic.SecuritySystemCurrentState.DISARMED
    ) {
      const triggerStart =
        Math.max(this.network.armedAt, this.network.updatedAt) +
        ARMED_DELAY * 1000;

      if (Date.now() >= triggerStart) {
        const motionResults = await Promise.all(
          this.network.cameras.map(c => c.getMotionDetected())
        );
        if (motionResults.includes(true)) {
          return this.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
        }
      }
    }
    return currentState;
  }

  private getTargetState(): number {
    return this.getSecurityState();
  }

  private getSecurityState(): number {
    if (this.network.armed) {
      const storedState = Number(this.network.context.armed);
      if (
        !Number.isNaN(storedState) &&
        storedState < this.Characteristic.SecuritySystemCurrentState.DISARMED
      ) {
        return storedState;
      }
      return this.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    }
    return this.Characteristic.SecuritySystemCurrentState.DISARMED;
  }

  private async setTargetState(value: number): Promise<void> {
    this.network.context.armed = value;
    const targetArmed =
      value !== this.Characteristic.SecuritySystemTargetState.DISARM;
    await this.network.setArmedState(targetArmed);
    this.pushStateUpdate();
  }

  /** Push current state to HomeKit (called after arm/disarm and from poll loop). */
  updateState(): void {
    this.pushStateUpdate();
  }

  private pushStateUpdate(): void {
    const currentState = this.getSecurityState();
    if (this.securityService) {
      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemCurrentState,
        currentState
      );
      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemTargetState,
        currentState
      );
    }
    if (this.armSwitchService) {
      this.armSwitchService.updateCharacteristic(
        this.Characteristic.On,
        this.network.armed
      );
    }
  }

  private cleanupStaleServices(): void {
    if (this.config.noAlarm) {
      const ss = this.accessory.getService(this.Service.SecuritySystem);
      if (ss) {
        this.accessory.removeService(ss);
      }
    }
    if (this.config.noManualArmSwitch) {
      const sw = this.accessory.getServiceById(
        this.Service.Switch,
        `armed.${this.network.serial}`
      );
      if (sw) {
        this.accessory.removeService(sw);
      }
    }
  }
}
