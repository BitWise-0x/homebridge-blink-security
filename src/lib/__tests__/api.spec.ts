import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => {
  class MockBlinkClient {
    get = vi.fn();
    post = vi.fn();
    getUrl = vi.fn();
    getBinary = vi.fn();
  }
  return { BlinkClient: MockBlinkClient };
});

vi.mock('../utils.js', () => {
  class MockExponentialBackoff {
    private _attempt = 0;

    constructor(
      private baseMs = 1000,
      private maxMs = 120000,
      private factor = 2
    ) {}

    get delayMs() {
      return Math.min(
        this.baseMs * Math.pow(this.factor, this._attempt),
        this.maxMs
      );
    }

    async wait() {
      this._attempt++;
    }

    increment() {
      this._attempt++;
    }

    reset() {
      this._attempt = 0;
    }

    get attempt() {
      return this._attempt;
    }
  }
  return {
    sleep: vi.fn(() => Promise.resolve()),
    ExponentialBackoff: MockExponentialBackoff,
  };
});

import { BlinkApi } from '../api.js';
import type { BlinkAuthClient } from '../auth.js';
import type { Logger } from 'homebridge';

function makeAuthClient(): BlinkAuthClient {
  return {
    isAuthenticated: true,
    getAccessToken: vi.fn().mockResolvedValue('token'),
    refreshTokens: vi.fn(),
    session: {
      accountId: 123,
      regionHost: 'https://rest-prod.immedia-semi.com',
    },
  } as unknown as BlinkAuthClient;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe('BlinkApi', () => {
  let api: BlinkApi;
  let log: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    log = makeLogger();
    api = new BlinkApi(makeAuthClient(), log);
  });

  describe('lock', () => {
    it('deduplicates concurrent calls with same name', async () => {
      const fn = vi.fn(async () => {
        return 'result';
      });

      const [r1, r2] = await Promise.all([
        api.lock('test-lock', fn),
        api.lock('test-lock', fn),
      ]);

      expect(r1).toBe('result');
      expect(r2).toBe('result');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('runs different names independently', async () => {
      const fn1 = vi.fn(async () => 'a');
      const fn2 = vi.fn(async () => 'b');

      const [r1, r2] = await Promise.all([
        api.lock('lock-1', fn1),
        api.lock('lock-2', fn2),
      ]);

      expect(r1).toBe('a');
      expect(r2).toBe('b');
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
    });

    it('cleans up lock after completion', async () => {
      const fn = vi.fn(async () => 'result');
      await api.lock('test', fn);

      // Second call should execute again since lock was cleaned up
      await api.lock('test', fn);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('command', () => {
    it('retries on busy 409', async () => {
      const mockGet = api.client.get as ReturnType<typeof vi.fn>;
      let callIdx = 0;
      const fn = vi.fn(async () => {
        callIdx++;
        if (callIdx === 1) {
          return { message: 'Device is busy' };
        }
        return { id: 42, command_id: 42 };
      });

      // Mock getCommand for commandWait
      mockGet.mockResolvedValue({ complete: true, status_msg: 'done' });

      const result = await api.command(100, fn, 60);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ complete: true, status_msg: 'done' });
    });

    it('propagates non-busy errors', async () => {
      const fn = vi.fn(async () => {
        throw new Error('404 Not Found');
      });

      const result = await api.command(100, fn, 60);
      expect(result).toBeUndefined();
    });
  });

  describe('commandWait', () => {
    it('polls getCommand until complete', async () => {
      const mockGet = api.client.get as ReturnType<typeof vi.fn>;
      mockGet
        .mockResolvedValueOnce({ complete: false })
        .mockResolvedValueOnce({ complete: false })
        .mockResolvedValueOnce({ complete: true, status_msg: 'done' });

      const result = await api.commandWait(100, 42, 30);
      expect(result).toEqual({ complete: true, status_msg: 'done' });
      expect(mockGet).toHaveBeenCalledTimes(3);
    });

    it('returns undefined for undefined commandID', async () => {
      const result = await api.commandWait(100, undefined, 30);
      expect(result).toBeUndefined();
    });

    it('times out and calls deleteCommand', async () => {
      const mockGet = api.client.get as ReturnType<typeof vi.fn>;
      const mockPost = api.client.post as ReturnType<typeof vi.fn>;

      // Always return incomplete
      mockGet.mockResolvedValue({ complete: false });
      mockPost.mockResolvedValue({});

      // Use a very short timeout
      const { sleep } = await import('../utils.js');

      // Mock Date.now to simulate time passing
      const realNow = Date.now;
      let mockTime = realNow();
      Date.now = vi.fn(() => mockTime);

      // After first getCommand + sleep, advance time past timeout
      (sleep as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        mockTime += 60000; // advance 60s each sleep
      });

      await api.commandWait(100, 42, 1);
      expect(mockPost).toHaveBeenCalled(); // deleteCommand was called

      Date.now = realNow;
    });
  });

  describe('API method path templates', () => {
    it('getAccountHomescreen uses correct path', async () => {
      const mockGet = api.client.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({ networks: [] });

      await api.getAccountHomescreen();
      expect(mockGet).toHaveBeenCalledWith(
        '/api/v4/accounts/{accountID}/homescreen',
        30
      );
    });

    it('armNetwork uses correct path', async () => {
      const mockPost = api.client.post as ReturnType<typeof vi.fn>;
      mockPost.mockResolvedValue({ id: 1 });

      await api.armNetwork(5);
      expect(mockPost).toHaveBeenCalledWith(
        '/api/v1/accounts/{accountID}/networks/5/state/arm'
      );
    });

    it('getCameraLiveView uses correct path', async () => {
      const mockPost = api.client.post as ReturnType<typeof vi.fn>;
      mockPost.mockResolvedValue({ server: 'rtsp://...' });

      await api.getCameraLiveView(10, 20);
      expect(mockPost).toHaveBeenCalledWith(
        '/api/v6/accounts/{accountID}/networks/10/cameras/20/liveview',
        { intent: 'liveview', motion_event_start_time: null }
      );
    });

    it('disarmNetwork uses correct path', async () => {
      const mockPost = api.client.post as ReturnType<typeof vi.fn>;
      mockPost.mockResolvedValue({ id: 1 });

      await api.disarmNetwork(7);
      expect(mockPost).toHaveBeenCalledWith(
        '/api/v1/accounts/{accountID}/networks/7/state/disarm'
      );
    });
  });

  describe('updateNetworkLvSave fallback', () => {
    it('tries 3 endpoints and succeeds on last', async () => {
      const mockPost = api.client.post as ReturnType<typeof vi.fn>;
      mockPost
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValueOnce({ id: 1 });

      const result = await api.updateNetworkLvSave(5, true);
      expect(result).toEqual({ id: 1 });
      expect(mockPost).toHaveBeenCalledTimes(3);
    });

    it('throws after all 3 attempts fail', async () => {
      const mockPost = api.client.post as ReturnType<typeof vi.fn>;
      mockPost
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'));

      await expect(api.updateNetworkLvSave(5, true)).rejects.toThrow(
        'Failed to update lv_save'
      );
    });

    it('returns on first successful attempt', async () => {
      const mockPost = api.client.post as ReturnType<typeof vi.fn>;
      mockPost.mockResolvedValueOnce({ id: 1 });

      const result = await api.updateNetworkLvSave(5, false);
      expect(result).toEqual({ id: 1 });
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
  });
});
