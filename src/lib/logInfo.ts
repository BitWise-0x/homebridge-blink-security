import type { Logger } from 'homebridge';
import type { BlinkOptions } from './config.js';

export function routineInfo(
  log: Logger,
  opts: BlinkOptions,
  msg: string
): void {
  if (!opts.hideRoutineLogs) {
    log.info(msg);
  }
}
