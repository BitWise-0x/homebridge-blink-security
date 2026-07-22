import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock axios before import
const mockRequest = vi.fn();
const mockInterceptorsRequestUse = vi.fn();
const mockInterceptorsResponseUse = vi.fn();
const mockAxiosInstance = {
  request: mockRequest,
  interceptors: {
    request: { use: mockInterceptorsRequestUse },
    response: { use: mockInterceptorsResponseUse },
  },
};

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance),
  },
}));

vi.mock('../request.js', () => ({
  DEFAULT_HEADERS: { 'Content-Type': 'application/json' },
}));

vi.mock('../utils.js', () => ({
  sleep: vi.fn(() => Promise.resolve()),
}));

import { BlinkClient } from '../client.js';
import type { BlinkAuthClient } from '../auth.js';
import type { Logger } from 'homebridge';

function makeAuthClient(
  overrides: Partial<{
    isAuthenticated: boolean;
    getAccessToken: () => Promise<string>;
    refreshTokens: () => Promise<void>;
    session: { accountId: number; regionHost: string };
  }> = {}
): BlinkAuthClient {
  return {
    isAuthenticated: true,
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    refreshTokens: vi.fn().mockResolvedValue(undefined),
    session: {
      accountId: 12345,
      regionHost: 'https://rest-prod.immedia-semi.com',
    },
    ...overrides,
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

describe('BlinkClient', () => {
  let authClient: ReturnType<typeof makeAuthClient>;
  let log: Logger;
  let client: BlinkClient;

  beforeEach(() => {
    vi.clearAllMocks();
    authClient = makeAuthClient();
    log = makeLogger();
    client = new BlinkClient(authClient, log);
  });

  describe('resolvePath', () => {
    it('replaces {accountID} with session accountId', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { ok: true },
      });
      await client.get('/api/v1/accounts/{accountID}/homescreen');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/api/v1/accounts/12345/homescreen'),
        })
      );
    });

    it('throws when accountID required but no session', async () => {
      const noSessionAuth = makeAuthClient({
        session: undefined as unknown as undefined,
      });
      const c = new BlinkClient(noSessionAuth, log);
      await expect(c.get('/api/v1/accounts/{accountID}/test')).rejects.toThrow(
        'accountID required'
      );
    });
  });

  describe('GET caching', () => {
    it('first call hits network', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { result: 1 },
      });
      const result = await client.get('/test', 10);
      expect(result).toEqual({ result: 1 });
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('second call within TTL returns cache', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { result: 1 },
      });
      await client.get('/test', 10);
      const result = await client.get('/test', 10);
      expect(result).toEqual({ result: 1 });
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after TTL expires', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { result: 1 },
      });
      await client.get('/test', 1);

      // Advance time past TTL
      const originalNow = Date.now;
      Date.now = vi.fn(() => originalNow() + 2000);

      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { result: 2 },
      });
      const result = await client.get('/test', 1);
      expect(result).toEqual({ result: 2 });
      expect(mockRequest).toHaveBeenCalledTimes(2);

      Date.now = originalNow;
    });
  });

  describe('POST invalidates GET cache', () => {
    it('clears cache for the same path on POST', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { result: 1 },
      });
      await client.get('/test', 60);

      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { posted: true },
      });
      await client.post('/test', { x: 1 });

      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { result: 2 },
      });
      const result = await client.get('/test', 60);
      expect(result).toEqual({ result: 2 });
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });
  });

  describe('binary detection', () => {
    it('sets arraybuffer responseType for .jpg URLs', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: Buffer.from('img'),
      });
      await client.get('/image.jpg');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ responseType: 'arraybuffer' })
      );
    });

    it('sets arraybuffer responseType for .png URLs', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: Buffer.from('img'),
      });
      await client.get('/image.png');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ responseType: 'arraybuffer' })
      );
    });

    it('sets arraybuffer responseType for /media/thumb/ URLs', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: Buffer.from('img'),
      });
      await client.get('/media/thumb/abc123');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ responseType: 'arraybuffer' })
      );
    });
  });

  describe('retry on network errors', () => {
    it('retries on ECONNRESET with backoff, max 2 retries', async () => {
      const { sleep } = await import('../utils.js');
      mockRequest
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: { ok: true },
        });

      const result = await client.get('/test', 0);
      expect(result).toEqual({ ok: true });
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });

    it('throws after exhausting retries', async () => {
      mockRequest
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'));

      await expect(client.get('/test', 0)).rejects.toThrow('ECONNRESET');
    });
  });

  describe('401 handling', () => {
    it('refreshes token and retries once on 401', async () => {
      mockRequest
        .mockResolvedValueOnce({
          status: 401,
          statusText: 'Unauthorized',
          data: {},
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: { ok: true },
        });

      const result = await client.get('/test', 0);
      expect(result).toEqual({ ok: true });
      expect(authClient.refreshTokens).toHaveBeenCalledTimes(1);
    });

    it('throws on second 401', async () => {
      mockRequest
        .mockResolvedValueOnce({
          status: 401,
          statusText: 'Unauthorized',
          data: {},
        })
        .mockResolvedValueOnce({
          status: 401,
          statusText: 'Unauthorized',
          data: {},
        });

      await expect(client.get('/test', 0)).rejects.toThrow('Unauthorized');
    });
  });

  describe('5xx retry', () => {
    it('retries on 500 with backoff', async () => {
      const { sleep } = await import('../utils.js');
      mockRequest
        .mockResolvedValueOnce({
          status: 500,
          statusText: 'Internal Server Error',
          data: {},
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: { ok: true },
        });

      const result = await client.get('/test', 0);
      expect(result).toEqual({ ok: true });
      expect(sleep).toHaveBeenCalled();
    });
  });

  describe('429 retry', () => {
    it('retries on 429 with backoff', async () => {
      const { sleep } = await import('../utils.js');
      mockRequest
        .mockResolvedValueOnce({
          status: 429,
          statusText: 'Too Many Requests',
          data: {},
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          data: { ok: true },
        });

      const result = await client.get('/test', 0);
      expect(result).toEqual({ ok: true });
      expect(sleep).toHaveBeenCalled();
    });
  });

  describe('409 handling', () => {
    it('returns data when 409 with "busy" message', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 409,
        statusText: 'Conflict',
        data: { message: 'Device is busy' },
      });

      const result = await client.get('/test', 0);
      expect(result).toEqual({ message: 'Device is busy' });
    });

    it('throws when 409 without "busy" message', async () => {
      mockRequest.mockResolvedValueOnce({
        status: 409,
        statusText: 'Conflict',
        data: { message: 'Some other conflict' },
      });

      await expect(client.get('/test', 0)).rejects.toThrow('409');
    });
  });

  describe('in-flight GET deduplication', () => {
    it('shares one network request between concurrent identical GETs', async () => {
      let release!: (value: unknown) => void;
      mockRequest.mockReturnValueOnce(
        new Promise(resolve => {
          release = resolve;
        })
      );

      const first = client.get('/test', 15);
      const second = client.get('/test', 15);
      release({ status: 200, statusText: 'OK', data: { ok: true } });

      expect(await first).toEqual({ ok: true });
      expect(await second).toEqual({ ok: true });
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('does not deduplicate cacheless (TTL 0) requests', async () => {
      mockRequest.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { ok: true },
      });

      await Promise.all([client.get('/test', 0), client.get('/test', 0)]);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('propagates a failure to all waiters and clears the slot', async () => {
      let reject!: (err: Error) => void;
      mockRequest.mockReturnValueOnce(
        new Promise((_resolve, rej) => {
          reject = rej;
        })
      );

      const first = client.get('/test', 15);
      const second = client.get('/test', 15);
      reject(new Error('boom'));

      await expect(first).rejects.toThrow('boom');
      await expect(second).rejects.toThrow('boom');

      // Slot cleared: a subsequent call issues a fresh request
      mockRequest.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { ok: true },
      });
      await expect(client.get('/test', 15)).resolves.toEqual({ ok: true });
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('does not deduplicate requests for different paths', async () => {
      mockRequest.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { ok: true },
      });

      await Promise.all([client.get('/a', 15), client.get('/b', 15)]);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
  });
});
