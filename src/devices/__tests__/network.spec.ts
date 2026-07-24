import { describe, it, expect, vi } from 'vitest';
import { BlinkNetwork, type NetworkData } from '../network.js';
import type { Blink } from '../index.js';

function makeNetwork(armed: boolean): BlinkNetwork {
  const data = {
    id: 100,
    name: 'Home',
    armed,
    updated_at: '2026-01-01T00:00:00Z',
  } as NetworkData;
  const blink = { setArmedState: vi.fn().mockResolvedValue(undefined) };
  return new BlinkNetwork(data, blink as unknown as Blink);
}

describe('BlinkNetwork armed interval stamping', () => {
  // Arm state also changes outside HomeKit (Blink app, schedules). The
  // motion gate needs both bounds of the armed interval, so transitions
  // seen in refreshed homescreen data must stamp them too.
  it('stamps disarmedAt when refreshed data goes armed to disarmed', () => {
    const network = makeNetwork(true);
    const before = Date.now();
    network.data = { ...network.data, armed: false };
    expect(network.disarmedAt).toBeGreaterThanOrEqual(before);
  });

  it('stamps armedAt when refreshed data goes disarmed to armed', () => {
    const network = makeNetwork(false);
    const before = Date.now();
    network.data = { ...network.data, armed: true };
    expect(network.armedAt).toBeGreaterThanOrEqual(before);
  });

  it('does not restamp on a refresh with no state change', () => {
    const network = makeNetwork(true);
    network.data = { ...network.data, armed: false };
    const stamped = network.disarmedAt;
    network.data = { ...network.data, armed: false };
    expect(network.disarmedAt).toBe(stamped);
  });

  it('stamps disarmedAt on a HomeKit-initiated disarm', async () => {
    const network = makeNetwork(true);
    const before = Date.now();
    await network.setArmedState(false);
    expect(network.disarmedAt).toBeGreaterThanOrEqual(before);
  });
});
