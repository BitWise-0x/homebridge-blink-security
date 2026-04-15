import {
  API,
  Categories,
  type CameraController,
  CameraControllerOptions,
  Characteristic,
  HAP,
  Logger,
  PlatformAccessory,
  type Service,
} from 'homebridge';

import type { BlinkCamera } from '../devices/camera.js';
import type { BlinkOptions } from '../lib/config.js';
import { BlinkCameraDelegate } from './cameraDelegate.js';

export class CameraAccessory {
  private readonly accessory: PlatformAccessory;
  private readonly camera: BlinkCamera;
  private readonly log: Logger;
  private readonly config: BlinkOptions;
  private readonly Characteristic: typeof Characteristic;
  private readonly Service: typeof Service;
  private readonly hap: HAP;
  private _controller?: CameraController;

  constructor(
    camera: BlinkCamera,
    api: API,
    log: Logger,
    config: BlinkOptions,
    cachedAccessories: PlatformAccessory[]
  ) {
    this.camera = camera;
    this.log = log;
    this.config = config;
    this.Characteristic = api.hap.Characteristic;
    this.Service = api.hap.Service;
    this.hap = api.hap;

    const uuid = api.hap.uuid.generate(camera.canonicalID);
    const existingAccessory = cachedAccessories.find(a => a.UUID === uuid);

    if (existingAccessory) {
      this.accessory = existingAccessory;
    } else {
      this.accessory = new api.platformAccessory(
        `Blink ${camera.name}`,
        uuid,
        Categories.CAMERA
      );
    }

    this.accessory.context.canonicalID = camera.canonicalID;

    const existingContext = cachedAccessories
      .map(a => a.context)
      .find(c => c.canonicalID === camera.canonicalID);
    if (existingContext) {
      Object.assign(this.accessory.context, existingContext);
    }
    // Privacy mode defaults to OFF on every startup — users must explicitly enable it
    this.accessory.context._privacy = false;
    camera.context = this.accessory.context;

    this.setupAccessoryInfo();
    this.setupCameraController();
    this.setupMotionSensor();

    if (camera.isBatteryPower) {
      this.setupBattery();
    }
    if (!camera.isCameraMini && !config.noTemperatureSensor) {
      this.setupTemperatureSensor();
    }

    if (!config.noEnabledSwitch) {
      this.setupEnabledSwitch();
    }

    if (!config.noPrivacySwitch) {
      this.setupPrivacySwitch();
    }

    if (!camera.isCameraMini) {
      this.setupNightVisionSwitch();
    }

    this.setupRecordClipSwitch();
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
      .setCharacteristic(this.Characteristic.Name, this.camera.name)
      .setCharacteristic(this.Characteristic.Manufacturer, 'Blink');

    if (this.camera.firmware) {
      infoService.setCharacteristic(
        this.Characteristic.FirmwareRevision,
        this.camera.firmware
      );
    }
    if (this.camera.model) {
      infoService.setCharacteristic(
        this.Characteristic.Model,
        this.camera.model
      );
    }
    if (this.camera.serial) {
      infoService.setCharacteristic(
        this.Characteristic.SerialNumber,
        this.camera.serial
      );
    }
  }

  private setupCameraController(): void {
    const delegate = new BlinkCameraDelegate(
      this.camera,
      this.log,
      this.hap,
      this.config.liveView,
      this.config.enableAudio
    );

    const controllerOptions: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate,
      streamingOptions: {
        supportedCryptoSuites: [
          this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
        ],
        video: {
          codec: {
            profiles: [
              this.hap.H264Profile.BASELINE,
              this.hap.H264Profile.MAIN,
            ],
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL4_0],
          },
          resolutions: [
            [1920, 1080, 15],
            [1280, 720, 30],
            [1280, 720, 15],
            [640, 480, 30],
            [640, 480, 15],
            [640, 360, 15],
            [480, 360, 15],
            [320, 240, 15],
          ],
        },
        audio: {
          twoWayAudio: false,
          codecs: [
            {
              type: this.hap.AudioStreamingCodecType.OPUS,
              samplerate: this.hap.AudioStreamingSamplerate.KHZ_24,
            },
            {
              type: this.hap.AudioStreamingCodecType.AAC_ELD,
              samplerate: this.hap.AudioStreamingSamplerate.KHZ_16,
            },
          ],
        },
      },
    };

    this._controller = new this.hap.CameraController(controllerOptions);
    delegate.controller = this._controller;
    this.accessory.configureController(this._controller);

    const cameraMode = this.accessory.getService(
      this.Service.CameraOperatingMode
    );
    if (cameraMode) {
      cameraMode
        .getCharacteristic(this.Characteristic.ManuallyDisabled)
        .onGet(() => !this.camera.enabled);
    }
  }

  private applyConfiguredName(service: Service, name: string): void {
    service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
    service.setCharacteristic(this.Characteristic.ConfiguredName, name);
  }

  private setupMotionSensor(): void {
    const name = `${this.camera.name} Motion`;
    const motionService =
      this.accessory.getService(this.Service.MotionSensor) ||
      this.accessory.addService(
        this.Service.MotionSensor,
        name,
        `motion.${this.camera.serial}`
      );

    this.applyConfiguredName(motionService, name);

    motionService
      .getCharacteristic(this.Characteristic.MotionDetected)
      .onGet(async () => this.camera.getMotionDetected());
  }

  private setupBattery(): void {
    const name = `${this.camera.name} Battery`;
    const batteryService =
      this.accessory.getService(this.Service.Battery) ||
      this.accessory.addService(
        this.Service.Battery,
        name,
        `battery-sensor.${this.camera.serial}`
      );

    this.applyConfiguredName(batteryService, name);

    batteryService
      .getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(() => {
        return this.camera.lowBattery
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      });

    batteryService
      .getCharacteristic(this.Characteristic.BatteryLevel)
      .onGet(() => this.camera.batteryLevel ?? 0);
  }

  private setupTemperatureSensor(): void {
    const name = `${this.camera.name} Temperature`;
    const tempService =
      this.accessory.getService(this.Service.TemperatureSensor) ||
      this.accessory.addService(
        this.Service.TemperatureSensor,
        name,
        `temp-sensor.${this.camera.serial}`
      );

    this.applyConfiguredName(tempService, name);

    tempService
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -100 });
    tempService
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => this.camera.temperature ?? 0);
  }

  private setupEnabledSwitch(): void {
    const name = `${this.camera.name} Motion Enabled`;
    const service =
      this.accessory.getService(`enabled.${this.camera.serial}`) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        `enabled.${this.camera.serial}`
      );

    this.applyConfiguredName(service, name);

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.camera.getEnabled())
      .onSet(async value => {
        await this.camera.setEnabled(value as boolean);
      });
  }

  private setupPrivacySwitch(): void {
    const name = `${this.camera.name} Privacy Mode`;
    const service =
      this.accessory.getService(`privacy.${this.camera.serial}`) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        `privacy.${this.camera.serial}`
      );

    this.applyConfiguredName(service, name);

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.camera.privacyMode)
      .onSet(value => {
        this.camera.privacyMode = value as boolean;
      });
  }

  private setupNightVisionSwitch(): void {
    const name = `${this.camera.name} Night Vision`;
    const service =
      this.accessory.getService(`nightvision.${this.camera.serial}`) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        `nightvision.${this.camera.serial}`
      );

    this.applyConfiguredName(service, name);

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.camera.nightVision)
      .onSet(async value => {
        await this.camera.setNightVision(value as boolean);
      });
  }

  private setupRecordClipSwitch(): void {
    const name = `${this.camera.name} Record Clip`;
    const service =
      this.accessory.getService(`record.${this.camera.serial}`) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        `record.${this.camera.serial}`
      );

    this.applyConfiguredName(service, name);

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet(async value => {
        if (value) {
          try {
            this.log.info(`${this.camera.name}: Recording clip`);
            await this.camera.recordClip();
          } finally {
            setTimeout(() => {
              service.updateCharacteristic(this.Characteristic.On, false);
            }, 1000);
          }
        }
      });
  }

  /** Push updated values to HomeKit (called from poll loop). */
  updateState(): void {
    const motionService = this.accessory.getService(this.Service.MotionSensor);
    if (motionService) {
      this.camera
        .getMotionDetected()
        .then(motion => {
          motionService.updateCharacteristic(
            this.Characteristic.MotionDetected,
            motion
          );
        })
        .catch(() => {
          /* ignore */
        });
    }

    const enabledService = this.accessory.getService(
      `enabled.${this.camera.serial}`
    );
    if (enabledService) {
      enabledService.updateCharacteristic(
        this.Characteristic.On,
        this.camera.getEnabled()
      );
    }

    if (this.camera.isBatteryPower) {
      const batteryService = this.accessory.getService(this.Service.Battery);
      if (batteryService) {
        batteryService.updateCharacteristic(
          this.Characteristic.BatteryLevel,
          this.camera.batteryLevel ?? 0
        );
        batteryService.updateCharacteristic(
          this.Characteristic.StatusLowBattery,
          this.camera.lowBattery
            ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        );
      }
    }

    const tempService = this.accessory.getService(
      this.Service.TemperatureSensor
    );
    if (tempService) {
      tempService.updateCharacteristic(
        this.Characteristic.CurrentTemperature,
        this.camera.temperature ?? 0
      );
    }
  }

  private cleanupStaleServices(): void {
    const removeSwitch = (subtype: string) => {
      const svc = this.accessory.getServiceById(this.Service.Switch, subtype);
      if (svc) {
        this.accessory.removeService(svc);
      }
    };

    if (this.config.noEnabledSwitch) {
      removeSwitch(`enabled.${this.camera.serial}`);
    }
    if (this.config.noPrivacySwitch) {
      removeSwitch(`privacy.${this.camera.serial}`);
    }
    if (this.camera.isCameraMini) {
      removeSwitch(`nightvision.${this.camera.serial}`);
    }
    if (!this.camera.isBatteryPower) {
      const bat = this.accessory.getService(this.Service.Battery);
      if (bat) {
        this.accessory.removeService(bat);
      }
    }
    if (this.camera.isCameraMini || this.config.noTemperatureSensor) {
      const temp = this.accessory.getService(this.Service.TemperatureSensor);
      if (temp) {
        this.accessory.removeService(temp);
      }
    }
  }
}
