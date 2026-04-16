import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  type BlinkSecurityConfig,
  normalizeConfig,
  type BlinkOptions,
} from './lib/config.js';
import { BlinkAuthClient, BlinkAuth2FARequiredError } from './lib/auth.js';
import { routineInfo } from './lib/logInfo.js';
import { ExponentialBackoff } from './lib/utils.js';
import { Blink } from './devices/index.js';
import { SecuritySystemAccessory } from './accessories/securitySystem.js';
import { CameraAccessory } from './accessories/camera.js';
import { DoorbellAccessory } from './accessories/doorbell.js';
import { SirenAccessory } from './accessories/siren.js';

const BLINK_STATUS_EVENT_LOOP = 10;

export class BlinkSecurityPlatform implements DynamicPlatformPlugin {
  private readonly log: Logger;
  private readonly config: BlinkOptions;
  private readonly rawConfig: BlinkSecurityConfig;
  private readonly api: API;
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private blink?: Blink;
  private authClient?: BlinkAuthClient;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private readonly pollBackoff = new ExponentialBackoff(
    BLINK_STATUS_EVENT_LOOP * 1000,
    120000,
    2
  );
  private securityAccessories: SecuritySystemAccessory[] = [];
  private cameraAccessories: CameraAccessory[] = [];
  private doorbellAccessories: DoorbellAccessory[] = [];

  constructor(log: Logger, config: PlatformConfig, api: API) {
    this.log = log;
    this.rawConfig = config as BlinkSecurityConfig;
    this.config = normalizeConfig(this.rawConfig);
    this.config.storagePath = api.user.storagePath();
    this.api = api;

    if (!this.rawConfig.username || !this.rawConfig.password) {
      this.log.error(
        'Missing Blink account credentials (username, password) in config.json'
      );
      return;
    }

    this.api.on('didFinishLaunching', () => this.init());
    this.api.on('shutdown', () => this.shutdown());
  }

  private shutdown(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.authClient?.destroy();
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private async init(): Promise<void> {
    this.log.info('Initializing Blink Security');

    try {
      this.blink = await this.setupBlink();

      // Sync lv_save (Save Live View Clips) setting for each network
      for (const network of this.blink.networks.values()) {
        const current = network.data.lv_save;
        const desired = this.config.lvSave;
        routineInfo(
          this.log,
          this.config,
          `Blink ${network.name} - lv_save: ${current ?? 'unknown'} (config: ${desired})`
        );
        if (current !== undefined && current !== desired) {
          try {
            await this.blink.api.updateNetworkLvSave(network.data.id, desired);
            routineInfo(
              this.log,
              this.config,
              `Blink ${network.name} - lv_save updated to ${desired}`
            );
          } catch (e) {
            this.log.warn(
              `Blink ${network.name} - Failed to update lv_save: ${e}`
            );
          }
        }
      }

      this.log.info(
        `Blink discovered: ${this.blink.networks.size} networks, ${this.blink.cameras.size} cameras, ${this.blink.doorbells.size} doorbells, ${this.blink.sirens.size} sirens`
      );

      const accessories: PlatformAccessory[] = [];

      for (const network of this.blink.networks.values()) {
        if (this.config.noAlarm && this.config.noManualArmSwitch) {
          continue;
        }

        const securityAccessory = new SecuritySystemAccessory(
          network,
          this.api,
          this.log,
          this.config,
          this.cachedAccessories
        );
        this.securityAccessories.push(securityAccessory);
        accessories.push(securityAccessory.platformAccessory);
      }

      for (const camera of this.blink.cameras.values()) {
        const cameraAccessory = new CameraAccessory(
          camera,
          this.api,
          this.log,
          this.config,
          this.cachedAccessories
        );
        this.cameraAccessories.push(cameraAccessory);
        accessories.push(cameraAccessory.platformAccessory);
      }

      for (const doorbell of this.blink.doorbells.values()) {
        const doorbellAccessory = new DoorbellAccessory(
          doorbell,
          this.api,
          this.log,
          this.config,
          this.cachedAccessories
        );
        this.doorbellAccessories.push(doorbellAccessory);
        accessories.push(doorbellAccessory.platformAccessory);
      }

      for (const siren of this.blink.sirens.values()) {
        const sirenAccessory = new SirenAccessory(
          siren,
          this.api,
          this.log,
          this.config,
          this.cachedAccessories
        );
        accessories.push(sirenAccessory.platformAccessory);
      }

      const activeUUIDs = new Set(accessories.map(a => a.UUID));
      const staleAccessories = this.cachedAccessories.filter(
        a => !activeUUIDs.has(a.UUID)
      );

      if (staleAccessories.length > 0) {
        this.api.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          staleAccessories
        );
      }

      const cachedUUIDs = new Set(this.cachedAccessories.map(a => a.UUID));
      const newAccessories = accessories.filter(a => !cachedUUIDs.has(a.UUID));

      if (newAccessories.length > 0) {
        this.log.info(
          `Registering ${newAccessories.length} new accessories: ${newAccessories.map(a => a.displayName).join(', ')}`
        );
        this.api.registerPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          newAccessories
        );
      }

      this.log.info(
        `Blink ready: ${accessories.length} total accessories (${newAccessories.length} new, ${staleAccessories.length} stale removed, ${this.cachedAccessories.length} cached)`
      );

      this.schedulePoll();
    } catch (err) {
      this.log.error(String(err));
      if (err instanceof BlinkAuth2FARequiredError) {
        this.log.error(
          'Blink devices in HomeKit will not be responsive until 2FA is completed.'
        );
        return;
      }
      // Don't retry on 2FA failures — the PIN is stale/invalid
      const errMsg = String(err);
      if (errMsg.includes('2FA') || errMsg.includes('OTP')) {
        this.log.error(
          'Blink 2FA failed. Enter a fresh PIN in the config and restart.'
        );
        return;
      }
      this.log.error('Blink initialization failed. Retrying in 30 seconds...');
      setTimeout(() => this.init(), 30000);
    }
  }

  private schedulePoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    const delayMs = this.pollBackoff.delayMs;
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.blink?.refreshData();
      this.pollBackoff.reset();
      this.pushUpdates();
    } catch (err) {
      this.log.error(String(err));
      this.pollBackoff.increment();
    }

    this.schedulePoll();
  }

  private pushUpdates(): void {
    for (const sa of this.securityAccessories) {
      sa.updateState();
    }
    for (const ca of this.cameraAccessories) {
      ca.updateState();
    }
    for (const da of this.doorbellAccessories) {
      da.updateState();
    }
  }

  private async setupBlink(): Promise<Blink> {
    if (!this.rawConfig.username || !this.rawConfig.password) {
      throw new Error('Missing Blink credentials in config.json');
    }

    const authClient = new BlinkAuthClient(this.config.storagePath);
    this.authClient = authClient;

    // Try to use existing session
    if (authClient.isAuthenticated) {
      this.log.info('Blink: Restored authenticated session');
    } else if (authClient.state === 'TOKEN_EXPIRED') {
      // Token expired — try refresh
      this.log.info('Blink: Session expired, refreshing token...');
      try {
        await authClient.refreshTokens();
        this.log.info('Blink: Token refreshed successfully');
      } catch {
        this.log.warn('Blink: Token refresh failed, re-authenticating...');
        await this.performAuth(authClient);
      }
    } else if (authClient.state === 'AWAITING_2FA' && this.config.pin) {
      // Run full auth + 2FA in a single session (session can't survive restarts)
      this.log.info('Blink: Running full auth + 2FA flow...');
      try {
        await authClient.authenticateWith2FA(
          this.rawConfig.username,
          this.rawConfig.password,
          this.config.pin
        );
        this.log.info('Blink: Authentication + 2FA verification successful');
      } catch (e) {
        this.log.error(String(e));
        throw new Error(
          'Blink 2FA verification failed. Check your PIN and restart.',
          { cause: e }
        );
      }
    } else {
      // Fresh authentication
      await this.performAuth(authClient);
    }

    const blink = new Blink(
      authClient,
      this.log,
      this.config.statusPollingSeconds,
      this.config.motionPollingSeconds,
      this.config.snapshotSeconds,
      this.config
    );

    await blink.refreshData();
    return blink;
  }

  private async performAuth(authClient: BlinkAuthClient): Promise<void> {
    try {
      await authClient.authenticate(
        this.rawConfig.username,
        this.rawConfig.password
      );
      this.log.info('Blink: Authentication successful');
    } catch (e) {
      if (e instanceof BlinkAuth2FARequiredError) {
        this.log.warn(
          'Blink: 2FA verification required. Enter your verification code in the plugin config "pin" field and restart Homebridge.'
        );
      }
      throw e;
    }
  }
}
