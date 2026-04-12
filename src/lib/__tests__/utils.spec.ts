import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sleep, fahrenheitToCelsius, ExponentialBackoff } from '../utils.js';

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the specified delay', async () => {
    const p = sleep(500);
    vi.advanceTimersByTime(500);
    await expect(p).resolves.toBeUndefined();
  });

  it('does not resolve before the delay', async () => {
    let resolved = false;
    sleep(1000).then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(999);
    await Promise.resolve();
    expect(resolved).toBe(false);
  });
});

describe('fahrenheitToCelsius', () => {
  beforeEach(() => vi.clearAllMocks());

  it('converts 32°F to 0°C', () => {
    expect(fahrenheitToCelsius(32)).toBe(0);
  });

  it('converts 212°F to 100°C', () => {
    expect(fahrenheitToCelsius(212)).toBe(100);
  });

  it('converts 0°F to -17.8°C', () => {
    expect(fahrenheitToCelsius(0)).toBe(-17.8);
  });

  it('converts negative Fahrenheit', () => {
    expect(fahrenheitToCelsius(-40)).toBe(-40);
  });

  it('rounds to 1 decimal place', () => {
    // 100°F = (100-32)/1.8 = 37.777...
    expect(fahrenheitToCelsius(100)).toBe(37.8);
  });
});

describe('ExponentialBackoff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns base delay initially', () => {
    const b = new ExponentialBackoff(1000, 120000, 2);
    expect(b.delayMs).toBe(1000);
  });

  it('grows delay by factor', () => {
    const b = new ExponentialBackoff(1000, 120000, 2);
    b.increment();
    expect(b.delayMs).toBe(2000);
    b.increment();
    expect(b.delayMs).toBe(4000);
  });

  it('caps delay at maxMs', () => {
    const b = new ExponentialBackoff(1000, 5000, 2);
    b.increment();
    b.increment();
    b.increment();
    b.increment(); // would be 16000 but capped at 5000
    expect(b.delayMs).toBe(5000);
  });

  it('resets attempt counter', () => {
    const b = new ExponentialBackoff(1000, 120000, 2);
    b.increment();
    b.increment();
    b.reset();
    expect(b.delayMs).toBe(1000);
    expect(b.attempt).toBe(0);
  });

  it('tracks attempt count', () => {
    const b = new ExponentialBackoff();
    expect(b.attempt).toBe(0);
    b.increment();
    expect(b.attempt).toBe(1);
    b.increment();
    expect(b.attempt).toBe(2);
  });

  it('wait() increments attempt after sleeping', async () => {
    vi.useFakeTimers();
    const b = new ExponentialBackoff(100, 10000, 2);
    expect(b.attempt).toBe(0);
    const p = b.wait();
    vi.advanceTimersByTime(100);
    await p;
    expect(b.attempt).toBe(1);
    vi.useRealTimers();
  });

  it('increment() does not sleep', () => {
    const b = new ExponentialBackoff(1000, 120000, 2);
    const before = Date.now();
    b.increment();
    const after = Date.now();
    expect(after - before).toBeLessThan(50);
  });
});
