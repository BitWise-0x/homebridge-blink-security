export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Reject if `promise` has not settled within `ms`. The underlying work is not
 * cancelled, so this bounds the wait rather than the request itself. The timer
 * is cleared on settle to avoid holding the event loop open.
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
};

export const fahrenheitToCelsius = (temperature: number): number =>
  Math.round(((temperature - 32) / 1.8) * 10) / 10;

export class ExponentialBackoff {
  private _attempt = 0;

  constructor(
    private readonly baseMs: number = 1000,
    private readonly maxMs: number = 120000,
    private readonly factor: number = 2
  ) {}

  get delayMs(): number {
    return Math.min(
      this.baseMs * Math.pow(this.factor, this._attempt),
      this.maxMs
    );
  }

  async wait(): Promise<void> {
    await sleep(this.delayMs);
    this._attempt++;
  }

  increment(): void {
    this._attempt++;
  }

  reset(): void {
    this._attempt = 0;
  }

  get attempt(): number {
    return this._attempt;
  }
}
