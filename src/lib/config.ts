import { isIPv4 } from 'net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'os';
import { PlatformConfig } from 'homebridge';

import { addressIsLocal } from './streamAddress.js';

export interface BlinkSecurityConfig extends PlatformConfig {
  username: string;
  password: string;
  pin?: string;
  'hide-alarm'?: boolean;
  'enable-alarm-triggering'?: boolean;
  'hide-manual-arm-switch'?: boolean;
  'hide-temperature-sensor'?: boolean;
  'hide-enabled-switch'?: boolean;
  'hide-privacy-switch'?: boolean;
  'hide-cameras'?: boolean;
  'hide-doorbells'?: boolean;
  'enable-liveview'?: boolean;
  'lv-save'?: boolean;
  'disable-thumbnail-refresh'?: boolean;
  'blink-status-polling-seconds'?: number;
  'camera-thumbnail-refresh-seconds'?: number;
  'camera-status-polling-seconds'?: number;
  'camera-motion-polling-seconds'?: number;
  logging?: 'quiet' | 'verbose' | 'debug';
  'enable-startup-diagnostic'?: boolean;
  'enable-audio'?: boolean;
  'audio-filter'?: string;
  'stream-address'?: string;
  'local-storage-motion'?: 'auto' | 'always' | 'never';
  'enable-push-notifications'?: boolean;
  'push-sign-in-callback'?: string;
}

export type LocalStorageMotionMode = 'auto' | 'always' | 'never';

export interface BlinkOptions {
  username: string;
  password: string;
  pin?: string;
  storagePath: string;
  noAlarm: boolean;
  alarmTriggering: boolean;
  noManualArmSwitch: boolean;
  noTemperatureSensor: boolean;
  noEnabledSwitch: boolean;
  noPrivacySwitch: boolean;
  noCameras: boolean;
  noDoorbells: boolean;
  liveView: boolean;
  lvSave: boolean;
  noThumbnailRefresh: boolean;
  blinkStatusPollingSeconds: number;
  snapshotSeconds: number;
  statusPollingSeconds: number;
  motionPollingSeconds: number;
  verbose: boolean;
  debug: boolean;
  startupDiagnostic: boolean;
  enableAudio: boolean;
  audioFilter: string;
  streamAddress: string;
  hideRoutineLogs: boolean;
  localStorageMotion: LocalStorageMotionMode;
  pushNotifications: boolean;
  pushSignInCallback?: string;
}

export const DEFAULT_OPTIONS: BlinkOptions = {
  username: '',
  password: '',
  storagePath: '',
  noAlarm: false,
  // Off by default: on 1.11.x the escalation was unreachable in practice,
  // so camera-only notifications are the behavior users actually know.
  alarmTriggering: false,
  noManualArmSwitch: false,
  noTemperatureSensor: false,
  noEnabledSwitch: false,
  noPrivacySwitch: false,
  noCameras: false,
  noDoorbells: false,
  liveView: true,
  lvSave: false,
  noThumbnailRefresh: false,
  blinkStatusPollingSeconds: 10,
  snapshotSeconds: 3600,
  statusPollingSeconds: 20,
  motionPollingSeconds: 15,
  verbose: false,
  debug: false,
  startupDiagnostic: false,
  enableAudio: false,
  audioFilter: '',
  streamAddress: '',
  hideRoutineLogs: false,
  localStorageMotion: 'auto',
  // Off by default: it registers an extra notification client on the Blink
  // account, which the user should opt into.
  pushNotifications: false,
};

export function normalizeConfig(
  config: BlinkSecurityConfig,
  warn?: (message: string) => void,
  interfaces: NodeJS.Dict<
    NetworkInterfaceInfo[] | undefined
  > = networkInterfaces()
): BlinkOptions {
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
  checkBoolean('enable-alarm-triggering', 'alarmTriggering');
  checkBoolean('hide-manual-arm-switch', 'noManualArmSwitch');
  checkBoolean('hide-temperature-sensor', 'noTemperatureSensor');
  checkBoolean('hide-enabled-switch', 'noEnabledSwitch');
  checkBoolean('hide-privacy-switch', 'noPrivacySwitch');
  checkBoolean('hide-cameras', 'noCameras');
  checkBoolean('hide-doorbells', 'noDoorbells');
  checkBoolean('enable-liveview', 'liveView');
  checkBoolean('lv-save', 'lvSave');
  checkBoolean('disable-thumbnail-refresh', 'noThumbnailRefresh');
  checkNumber('blink-status-polling-seconds', 'blinkStatusPollingSeconds');
  checkNumber('camera-thumbnail-refresh-seconds', 'snapshotSeconds');
  checkNumber('camera-status-polling-seconds', 'statusPollingSeconds');
  checkNumber('camera-motion-polling-seconds', 'motionPollingSeconds');
  checkBoolean('enable-startup-diagnostic', 'startupDiagnostic');
  checkBoolean('enable-audio', 'enableAudio');
  checkBoolean('enable-push-notifications', 'pushNotifications');

  const audioFilter =
    typeof config['audio-filter'] === 'string'
      ? config['audio-filter'].trim()
      : '';
  if (audioFilter) {
    opts.audioFilter = audioFilter;
  }

  const streamAddress =
    typeof config['stream-address'] === 'string'
      ? config['stream-address'].trim()
      : '';
  if (streamAddress) {
    if (isIPv4(streamAddress) && addressIsLocal(streamAddress, interfaces)) {
      opts.streamAddress = streamAddress;
    } else {
      warn?.(
        `stream-address ${streamAddress} is not an IPv4 address on this host; ignoring it and picking the Live View address automatically.`
      );
    }
  }

  if (opts.snapshotSeconds <= 0 || opts.noThumbnailRefresh) {
    opts.snapshotSeconds = Number.MAX_SAFE_INTEGER;
  }

  opts.hideRoutineLogs = config.logging === 'quiet';
  opts.verbose = ['verbose', 'debug'].includes(config.logging ?? '');
  opts.debug = config.logging === 'debug';

  const pushCallback =
    typeof config['push-sign-in-callback'] === 'string'
      ? config['push-sign-in-callback'].trim()
      : '';
  if (pushCallback) {
    opts.pushSignInCallback = pushCallback;
  }

  const lsMotion = config['local-storage-motion'];
  if (lsMotion && ['auto', 'always', 'never'].includes(lsMotion)) {
    opts.localStorageMotion = lsMotion;
  }

  return opts;
}
