import { PlatformConfig } from 'homebridge';

export interface BlinkSecurityConfig extends PlatformConfig {
  username: string;
  password: string;
  pin?: string;
  'hide-alarm'?: boolean;
  'hide-manual-arm-switch'?: boolean;
  'hide-temperature-sensor'?: boolean;
  'hide-enabled-switch'?: boolean;
  'hide-privacy-switch'?: boolean;
  'enable-liveview'?: boolean;
  'lv-save'?: boolean;
  'disable-thumbnail-refresh'?: boolean;
  'camera-thumbnail-refresh-seconds'?: number;
  'camera-status-polling-seconds'?: number;
  'camera-motion-polling-seconds'?: number;
  logging?: 'verbose' | 'debug';
  'enable-startup-diagnostic'?: boolean;
}

export interface BlinkOptions {
  username: string;
  password: string;
  pin?: string;
  storagePath: string;
  noAlarm: boolean;
  noManualArmSwitch: boolean;
  noTemperatureSensor: boolean;
  noEnabledSwitch: boolean;
  noPrivacySwitch: boolean;
  liveView: boolean;
  lvSave: boolean;
  noThumbnailRefresh: boolean;
  snapshotSeconds: number;
  statusPollingSeconds: number;
  motionPollingSeconds: number;
  verbose: boolean;
  debug: boolean;
  startupDiagnostic: boolean;
}

export const DEFAULT_OPTIONS: BlinkOptions = {
  username: '',
  password: '',
  storagePath: '',
  noAlarm: false,
  noManualArmSwitch: false,
  noTemperatureSensor: false,
  noEnabledSwitch: false,
  noPrivacySwitch: false,
  liveView: true,
  lvSave: false,
  noThumbnailRefresh: false,
  snapshotSeconds: 3600,
  statusPollingSeconds: 30,
  motionPollingSeconds: 15,
  verbose: false,
  debug: false,
  startupDiagnostic: false,
};

export function normalizeConfig(config: BlinkSecurityConfig): BlinkOptions {
  const opts: BlinkOptions = { ...DEFAULT_OPTIONS };

  opts.username = config.username ?? '';
  opts.password = config.password ?? '';
  opts.pin =
    config.pin !== null && config.pin !== undefined
      ? String(config.pin)
      : undefined;

  const checkBoolean = (
    key: keyof BlinkSecurityConfig,
    prop: keyof BlinkOptions
  ) => {
    const val = config[key];
    if (val !== undefined && val !== null && val !== '') {
      (opts as unknown as Record<string, unknown>)[prop] = Boolean(val);
    }
  };

  const checkNumber = (
    key: keyof BlinkSecurityConfig,
    prop: keyof BlinkOptions
  ) => {
    const val = config[key];
    if (val !== undefined && val !== null && val !== '') {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        (opts as unknown as Record<string, unknown>)[prop] = num;
      }
    }
  };

  checkBoolean('hide-alarm', 'noAlarm');
  checkBoolean('hide-manual-arm-switch', 'noManualArmSwitch');
  checkBoolean('hide-temperature-sensor', 'noTemperatureSensor');
  checkBoolean('hide-enabled-switch', 'noEnabledSwitch');
  checkBoolean('hide-privacy-switch', 'noPrivacySwitch');
  checkBoolean('enable-liveview', 'liveView');
  checkBoolean('lv-save', 'lvSave');
  checkBoolean('disable-thumbnail-refresh', 'noThumbnailRefresh');
  checkNumber('camera-thumbnail-refresh-seconds', 'snapshotSeconds');
  checkNumber('camera-status-polling-seconds', 'statusPollingSeconds');
  checkNumber('camera-motion-polling-seconds', 'motionPollingSeconds');
  checkBoolean('enable-startup-diagnostic', 'startupDiagnostic');

  if (opts.snapshotSeconds <= 0 || opts.noThumbnailRefresh) {
    opts.snapshotSeconds = Number.MAX_SAFE_INTEGER;
  }

  opts.verbose = ['verbose', 'debug'].includes(config.logging ?? '');
  opts.debug = config.logging === 'debug';

  return opts;
}
