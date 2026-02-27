import { PlatformAccessory } from 'homebridge';

import type { BlinkDeviceContext } from '../devices/base.js';

export type BlinkAccessoryContext = BlinkDeviceContext;

export type BlinkPlatformAccessory = PlatformAccessory & {
  context: BlinkAccessoryContext;
};

export { SecuritySystemAccessory } from './securitySystem.js';
export { CameraAccessory } from './camera.js';
export { DoorbellAccessory } from './doorbell.js';
export { SirenAccessory } from './siren.js';
