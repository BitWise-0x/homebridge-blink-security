export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

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
