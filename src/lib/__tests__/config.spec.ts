import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeConfig, DEFAULT_OPTIONS } from '../config.js';
import type { BlinkSecurityConfig } from '../config.js';

function makeConfig(
  overrides: Partial<BlinkSecurityConfig> = {}
): BlinkSecurityConfig {
  return {
    platform: 'BlinkSecurity',
    username: 'test@example.com',
    password: 'pass123',
    ...overrides,
  } as BlinkSecurityConfig;
}

describe('normalizeConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('default values', () => {
    it('returns defaults for minimal config', () => {
      const opts = normalizeConfig(makeConfig());
      expect(opts.username).toBe('test@example.com');
      expect(opts.password).toBe('pass123');
      expect(opts.noAlarm).toBe(false);
      expect(opts.noManualArmSwitch).toBe(false);
      expect(opts.noTemperatureSensor).toBe(false);
      expect(opts.noEnabledSwitch).toBe(false);
      expect(opts.noPrivacySwitch).toBe(false);
      expect(opts.liveView).toBe(true);
      expect(opts.lvSave).toBe(false);
      expect(opts.noThumbnailRefresh).toBe(false);
      expect(opts.snapshotSeconds).toBe(3600);
      expect(opts.statusPollingSeconds).toBe(30);
      expect(opts.motionPollingSeconds).toBe(15);
      expect(opts.verbose).toBe(false);
      expect(opts.debug).toBe(false);
      expect(opts.startupDiagnostic).toBe(false);
      expect(opts.hideRoutineLogs).toBe(false);
    });
  });

  describe('boolean coercion', () => {
    it('coerces string "true" to true', () => {
      const opts = normalizeConfig(
        makeConfig({ 'hide-alarm': 'true' as unknown as boolean })
      );
      expect(opts.noAlarm).toBe(true);
    });

    it('coerces string "false" to true (truthy string)', () => {
      // Boolean("false") === true
      const opts = normalizeConfig(
        makeConfig({ 'hide-alarm': 'false' as unknown as boolean })
      );
      expect(opts.noAlarm).toBe(true);
    });

    it('coerces boolean true to true', () => {
      const opts = normalizeConfig(makeConfig({ 'hide-alarm': true }));
      expect(opts.noAlarm).toBe(true);
    });

    it('coerces boolean false to false', () => {
      const opts = normalizeConfig(makeConfig({ 'hide-alarm': false }));
      expect(opts.noAlarm).toBe(false);
    });

    it('ignores undefined values (keeps default)', () => {
      const opts = normalizeConfig(makeConfig({ 'hide-alarm': undefined }));
      expect(opts.noAlarm).toBe(DEFAULT_OPTIONS.noAlarm);
    });

    it('ignores null values (keeps default)', () => {
      const opts = normalizeConfig(
        makeConfig({ 'hide-alarm': null as unknown as boolean })
      );
      expect(opts.noAlarm).toBe(DEFAULT_OPTIONS.noAlarm);
    });

    it('ignores empty string (keeps default)', () => {
      const opts = normalizeConfig(
        makeConfig({ 'hide-alarm': '' as unknown as boolean })
      );
      expect(opts.noAlarm).toBe(DEFAULT_OPTIONS.noAlarm);
    });
  });

  describe('number coercion', () => {
    it('coerces valid number string', () => {
      const opts = normalizeConfig(
        makeConfig({
          'camera-thumbnail-refresh-seconds': '120' as unknown as number,
        })
      );
      expect(opts.snapshotSeconds).toBe(120);
    });

    it('ignores NaN values', () => {
      const opts = normalizeConfig(
        makeConfig({
          'camera-thumbnail-refresh-seconds': 'abc' as unknown as number,
        })
      );
      expect(opts.snapshotSeconds).toBe(DEFAULT_OPTIONS.snapshotSeconds);
    });

    it('ignores empty string', () => {
      const opts = normalizeConfig(
        makeConfig({
          'camera-thumbnail-refresh-seconds': '' as unknown as number,
        })
      );
      expect(opts.snapshotSeconds).toBe(DEFAULT_OPTIONS.snapshotSeconds);
    });

    it('ignores null', () => {
      const opts = normalizeConfig(
        makeConfig({
          'camera-thumbnail-refresh-seconds': null as unknown as number,
        })
      );
      expect(opts.snapshotSeconds).toBe(DEFAULT_OPTIONS.snapshotSeconds);
    });
  });

  describe('pin coercion', () => {
    it('converts numeric pin to string', () => {
      const opts = normalizeConfig(
        makeConfig({ pin: 1234 as unknown as string })
      );
      expect(opts.pin).toBe('1234');
    });

    it('keeps string pin as-is', () => {
      const opts = normalizeConfig(makeConfig({ pin: '5678' }));
      expect(opts.pin).toBe('5678');
    });

    it('returns undefined for null pin', () => {
      const opts = normalizeConfig(
        makeConfig({ pin: null as unknown as string })
      );
      expect(opts.pin).toBeUndefined();
    });

    it('returns undefined for undefined pin', () => {
      const opts = normalizeConfig(makeConfig());
      expect(opts.pin).toBeUndefined();
    });
  });

  describe('snapshotSeconds special cases', () => {
    it('sets MAX_SAFE_INTEGER when snapshotSeconds <= 0', () => {
      const opts = normalizeConfig(
        makeConfig({ 'camera-thumbnail-refresh-seconds': -1 })
      );
      expect(opts.snapshotSeconds).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('sets MAX_SAFE_INTEGER when snapshotSeconds is 0', () => {
      const opts = normalizeConfig(
        makeConfig({ 'camera-thumbnail-refresh-seconds': 0 })
      );
      expect(opts.snapshotSeconds).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('sets MAX_SAFE_INTEGER when noThumbnailRefresh is true', () => {
      const opts = normalizeConfig(
        makeConfig({ 'disable-thumbnail-refresh': true })
      );
      expect(opts.snapshotSeconds).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('verbose, debug, and hideRoutineLogs from logging', () => {
    it('sets hideRoutineLogs=true for logging "quiet"', () => {
      const opts = normalizeConfig(makeConfig({ logging: 'quiet' }));
      expect(opts.hideRoutineLogs).toBe(true);
      expect(opts.verbose).toBe(false);
      expect(opts.debug).toBe(false);
    });

    it('sets verbose=true, debug=false for logging "verbose"', () => {
      const opts = normalizeConfig(makeConfig({ logging: 'verbose' }));
      expect(opts.hideRoutineLogs).toBe(false);
      expect(opts.verbose).toBe(true);
      expect(opts.debug).toBe(false);
    });

    it('sets both verbose=true and debug=true for logging "debug"', () => {
      const opts = normalizeConfig(makeConfig({ logging: 'debug' }));
      expect(opts.hideRoutineLogs).toBe(false);
      expect(opts.verbose).toBe(true);
      expect(opts.debug).toBe(true);
    });

    it('sets all false when logging is undefined', () => {
      const opts = normalizeConfig(makeConfig());
      expect(opts.hideRoutineLogs).toBe(false);
      expect(opts.verbose).toBe(false);
      expect(opts.debug).toBe(false);
    });

    it('sets all false for unknown logging value', () => {
      const opts = normalizeConfig(
        makeConfig({ logging: 'info' as 'verbose' })
      );
      expect(opts.hideRoutineLogs).toBe(false);
      expect(opts.verbose).toBe(false);
      expect(opts.debug).toBe(false);
    });
  });

  describe('config key to option field mappings', () => {
    it('maps hide-manual-arm-switch to noManualArmSwitch', () => {
      const opts = normalizeConfig(
        makeConfig({ 'hide-manual-arm-switch': true })
      );
      expect(opts.noManualArmSwitch).toBe(true);
    });

    it('maps hide-temperature-sensor to noTemperatureSensor', () => {
      const opts = normalizeConfig(
        makeConfig({ 'hide-temperature-sensor': true })
      );
      expect(opts.noTemperatureSensor).toBe(true);
    });

    it('maps hide-enabled-switch to noEnabledSwitch', () => {
      const opts = normalizeConfig(makeConfig({ 'hide-enabled-switch': true }));
      expect(opts.noEnabledSwitch).toBe(true);
    });

    it('maps hide-privacy-switch to noPrivacySwitch', () => {
      const opts = normalizeConfig(makeConfig({ 'hide-privacy-switch': true }));
      expect(opts.noPrivacySwitch).toBe(true);
    });

    it('maps enable-liveview to liveView', () => {
      const opts = normalizeConfig(makeConfig({ 'enable-liveview': false }));
      expect(opts.liveView).toBe(false);
    });

    it('maps lv-save to lvSave', () => {
      const opts = normalizeConfig(makeConfig({ 'lv-save': true }));
      expect(opts.lvSave).toBe(true);
    });

    it('maps camera-status-polling-seconds to statusPollingSeconds', () => {
      const opts = normalizeConfig(
        makeConfig({ 'camera-status-polling-seconds': 60 })
      );
      expect(opts.statusPollingSeconds).toBe(60);
    });

    it('maps camera-motion-polling-seconds to motionPollingSeconds', () => {
      const opts = normalizeConfig(
        makeConfig({ 'camera-motion-polling-seconds': 45 })
      );
      expect(opts.motionPollingSeconds).toBe(45);
    });

    it('maps enable-startup-diagnostic to startupDiagnostic', () => {
      const opts = normalizeConfig(
        makeConfig({ 'enable-startup-diagnostic': true })
      );
      expect(opts.startupDiagnostic).toBe(true);
    });

    it('maps enable-audio to enableAudio', () => {
      const opts = normalizeConfig(makeConfig({ 'enable-audio': true }));
      expect(opts.enableAudio).toBe(true);
    });

    it('defaults enableAudio to false', () => {
      const opts = normalizeConfig(makeConfig({}));
      expect(opts.enableAudio).toBe(false);
    });
  });
});
