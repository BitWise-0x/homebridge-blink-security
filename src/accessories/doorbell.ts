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

import type { BlinkDoorbell } from '../devices/doorbell.js';
import type { BlinkOptions } from '../lib/config.js';
import { BlinkCameraDelegate } from './cameraDelegate.js';

export class DoorbellAccessory {
  private readonly accessory: PlatformAccessory;
  private readonly doorbell: BlinkDoorbell;
  private readonly log: Logger;
  private readonly config: BlinkOptions;
  private readonly Characteristic: typeof Characteristic;
  private readonly Service: typeof Service;
  private readonly hap: HAP;
  private _controller?: CameraController;
  private doorbellService?: Service;

  constructor(
    doorbell: BlinkDoorbell,
    api: API,
    log: Logger,
    config: BlinkOptions,
    cachedAccessories: PlatformAccessory[]
  ) {
    this.doorbell = doorbell;
    this.log = log;
    this.config = config;
    this.Characteristic = api.hap.Characteristic;
    this.Service = api.hap.Service;
    this.hap = api.hap;

    const uuid = api.hap.uuid.generate(doorbell.canonicalID);
    const existingAccessory = cachedAccessories.find(a => a.UUID === uuid);

    if (existingAccessory) {
      this.accessory = existingAccessory;
    } else {
      this.accessory = new api.platformAccessory(
        `Blink ${doorbell.name}`,
        uuid,
        Categories.VIDEO_DOORBELL
      );
    }

    this.accessory.context.canonicalID = doorbell.canonicalID;

    const existingContext = cachedAccessories
      .map(a => a.context)
      .find(c => c.canonicalID === doorbell.canonicalID);
    if (existingContext) {
      Object.assign(this.accessory.context, existingContext);
    }
    // Privacy mode defaults to OFF on every startup — users must explicitly enable it
    this.accessory.context._privacy = false;
    doorbell.context = this.accessory.context;

    this.setupAccessoryInfo();
    this.setupCameraController();
    this.setupDoorbellService();
    this.setupMotionSensor();

    if (!config.noEnabledSwitch) {
      this.setupEnabledSwitch();
    }

    if (!config.noPrivacySwitch) {
      this.setupPrivacySwitch();
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
      .setCharacteristic(this.Characteristic.Name, this.doorbell.name)
      .setCharacteristic(this.Characteristic.Manufacturer, 'Blink');

    if (this.doorbell.firmware) {
      infoService.setCharacteristic(
        this.Characteristic.FirmwareRevision,
        this.doorbell.firmware
      );
    }
    if (this.doorbell.model) {
      infoService.setCharacteristic(
        this.Characteristic.Model,
        this.doorbell.model
      );
    }
    if (this.doorbell.serial) {
      infoService.setCharacteristic(
        this.Characteristic.SerialNumber,
        this.doorbell.serial
      );
    }
  }

  private setupCameraController(): void {
    const delegate = new BlinkCameraDelegate(
      this.doorbell,
      this.log,
      this.hap,
      this.config.liveView
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
  }

  private setupDoorbellService(): void {
    this.doorbellService =
      this.accessory.getService(this.Service.Doorbell) ||
      this.accessory.addService(
        this.Service.Doorbell,
        `${this.doorbell.name} Doorbell`,
        `doorbell.${this.doorbell.serial}`
      );

    this.doorbellService
      .getCharacteristic(this.Characteristic.ProgrammableSwitchEvent)
      .onGet(() => null);

    this.doorbell.onPress = () => {
      this.log.info(`${this.doorbell.name}: Doorbell pressed`);
      this.doorbellService?.updateCharacteristic(
        this.Characteristic.ProgrammableSwitchEvent,
        this.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
      );
    };
  }

  private setupMotionSensor(): void {
    const motionService =
      this.accessory.getService(this.Service.MotionSensor) ||
      this.accessory.addService(
        this.Service.MotionSensor,
        `${this.doorbell.name} Motion`,
        `motion.${this.doorbell.serial}`
      );

    motionService
      .getCharacteristic(this.Characteristic.MotionDetected)
      .onGet(async () => this.doorbell.getMotionDetected());
  }

  private setupEnabledSwitch(): void {
    const service =
      this.accessory.getService(`enabled.${this.doorbell.serial}`) ||
      this.accessory.addService(
        this.Service.Switch,
        `${this.doorbell.name} Motion Enabled`,
        `enabled.${this.doorbell.serial}`
      );

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.doorbell.getEnabled())
      .onSet(async value => {
        await this.doorbell.setEnabled(value as boolean);
      });
  }

  private setupPrivacySwitch(): void {
    const service =
      this.accessory.getService(`privacy.${this.doorbell.serial}`) ||
      this.accessory.addService(
        this.Service.Switch,
        `${this.doorbell.name} Privacy Mode`,
        `privacy.${this.doorbell.serial}`
      );

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.doorbell.privacyMode)
      .onSet(value => {
        this.doorbell.privacyMode = value as boolean;
      });
  }

  private setupRecordClipSwitch(): void {
    const service =
      this.accessory.getService(`record.${this.doorbell.serial}`) ||
      this.accessory.addService(
        this.Service.Switch,
        `${this.doorbell.name} Record Clip`,
        `record.${this.doorbell.serial}`
      );

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet(async value => {
        if (value) {
          try {
            this.log.info(`${this.doorbell.name}: Recording clip`);
            await this.doorbell.recordClip();
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
      this.doorbell
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
      `enabled.${this.doorbell.serial}`
    );
    if (enabledService) {
      enabledService.updateCharacteristic(
        this.Characteristic.On,
        this.doorbell.getEnabled()
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
      removeSwitch(`enabled.${this.doorbell.serial}`);
    }
    if (this.config.noPrivacySwitch) {
      removeSwitch(`privacy.${this.doorbell.serial}`);
    }
  }
}
