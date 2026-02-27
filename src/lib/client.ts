import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type AxiosRequestConfig,
} from 'axios';
import { Logger } from 'homebridge';

import { DEFAULT_HEADERS } from './request.js';
import type { BlinkAuthClient } from './auth.js';
import { sleep } from './utils.js';

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

export class BlinkClient {
  private readonly authClient: BlinkAuthClient;
  private readonly log: Logger;
  private readonly client: AxiosInstance;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(authClient: BlinkAuthClient, log: Logger) {
    this.authClient = authClient;
    this.log = log;

    this.client = axios.create({
      headers: { ...DEFAULT_HEADERS },
      timeout: 30000,
    });

    this.client.interceptors.request.use(async config => {
      if (this.authClient.isAuthenticated) {
        const token = await this.authClient.getAccessToken();
        config.headers['Authorization'] = `Bearer ${token}`;
      }
      return config;
    });
  }

  get accountID(): number | undefined {
    return this.authClient.session?.accountId;
  }

  private get baseURL(): string {
    return (
      this.authClient.session?.regionHost ??
      'https://rest-prod.immedia-semi.com'
    );
  }

  private resolvePath(path: string): string {
    if (path.includes('{accountID}')) {
      const accountId = this.authClient.session?.accountId;
      if (!accountId) {
        throw new Error('No authenticated session — accountID required');
      }
      return path.replace('{accountID}', String(accountId));
    }
    return path;
  }

  async get<T = unknown>(path: string, maxTTL = 1): Promise<T> {
    return this._request<T>('GET', path, undefined, maxTTL);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this._request<T>('POST', path, body, 0);
  }

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    maxTTL = 0,
    retryCount = 0
  ): Promise<T> {
    const resolvedPath = this.resolvePath(path);
    const cacheKey = `${method}:${resolvedPath}`;

    if (method === 'GET' && maxTTL > 0 && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      if (cached.timestamp + maxTTL * 1000 > Date.now()) {
        return cached.data as T;
      }
    }

    const url = resolvedPath.startsWith('http')
      ? resolvedPath
      : `${this.baseURL}${resolvedPath}`;
    const config: AxiosRequestConfig = {
      method,
      url,
      validateStatus: () => true,
    };

    // Binary response for image URLs (thumbnails and media)
    if (
      method === 'GET' &&
      (/\.(jpg|jpeg|png|bmp)(\?|$)/i.test(url) ||
        /\/media\/thumb\/|\/thumbnail/i.test(url))
    ) {
      config.responseType = 'arraybuffer';
    }

    if (body) {
      config.data = body;
      config.headers = { 'Content-Type': 'application/json' };
    }

    this.log.debug(`${method} ${resolvedPath} @${maxTTL}`);

    let res: AxiosResponse;
    try {
      res = await this.client.request(config);
    } catch (err) {
      const error = err as Error;
      if (/ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT/.test(error.message)) {
        if (retryCount < 2) {
          const backoffMs = Math.pow(2, retryCount) * 1000;
          await sleep(backoffMs);
          return this._request<T>(method, path, body, maxTTL, retryCount + 1);
        }
      }
      throw err;
    }

    this.log.debug(`${res.status} ${res.statusText}`);

    // 401 — refresh token and retry once
    if (res.status === 401 && retryCount < 1) {
      try {
        await this.authClient.refreshTokens();
      } catch {
        this.log.error(
          `${method} ${resolvedPath} (${res.status} ${res.statusText})`
        );
        throw new Error(`Unauthorized: ${res.status}`);
      }
      return this._request<T>(method, path, body, maxTTL, retryCount + 1);
    }

    if (res.status === 401) {
      this.log.error(
        `${method} ${resolvedPath} (${res.status} ${res.statusText})`
      );
      throw new Error(`Unauthorized: ${res.status}`);
    }

    // 5xx — exponential backoff retry
    if (res.status >= 500 && retryCount < 2) {
      const backoffMs = Math.pow(2, retryCount) * 1000;
      this.log.error(
        `RETRY: ${method} ${resolvedPath} (${res.status} ${res.statusText}) — retrying in ${backoffMs}ms`
      );
      await sleep(backoffMs);
      return this._request<T>(method, path, body, maxTTL, retryCount + 1);
    }

    // 429 — exponential backoff retry
    if (res.status === 429 && retryCount < 2) {
      const backoffMs = Math.pow(2, retryCount) * 1000;
      this.log.error(
        `RETRY: ${method} ${resolvedPath} (${res.status} Rate limited) — retrying in ${backoffMs}ms`
      );
      await sleep(backoffMs);
      return this._request<T>(method, path, body, maxTTL, retryCount + 1);
    }

    // 409 — busy (command in progress)
    if (res.status === 409) {
      if (!/busy/i.test(res.data?.message ?? '')) {
        throw new Error(`${method} ${resolvedPath} (${res.status})`);
      }
    } else if (res.status >= 400) {
      this.log.error(
        `${method} ${resolvedPath} (${res.status} ${res.statusText})`
      );
      throw new Error(`${method} ${resolvedPath} (${res.status})`);
    }

    if (method === 'GET' && res.status === 200) {
      this.cache.set(cacheKey, { data: res.data, timestamp: Date.now() });
    }

    if (method !== 'GET') {
      this.cache.delete(`GET:${this.resolvePath(path)}`);
    }

    return res.data as T;
  }

  async getUrl<T = unknown>(url: string): Promise<T> {
    return this.get<T>(url);
  }

  async getBinary(path: string): Promise<Buffer> {
    const resolvedPath = this.resolvePath(path);
    const url = resolvedPath.startsWith('http')
      ? resolvedPath
      : `${this.baseURL}${resolvedPath}`;

    const config: AxiosRequestConfig = {
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    };

    this.log.debug(`GET (binary) ${resolvedPath}`);
    let res: AxiosResponse;
    try {
      res = await this.client.request(config);
    } catch (err) {
      const error = err as Error;
      if (/ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT/.test(error.message)) {
        await sleep(1000);
        res = await this.client.request(config);
      } else {
        throw err;
      }
    }

    this.log.debug(
      `${res.status} ${res.statusText} (${res.data?.length ?? 0} bytes)`
    );

    if (res.status === 401) {
      try {
        await this.authClient.refreshTokens();
      } catch {
        throw new Error(`Unauthorized: GET ${resolvedPath} (${res.status})`);
      }
      const retry = await this.client.request(config);
      if (retry.status >= 400) {
        throw new Error(`GET ${resolvedPath} (${retry.status})`);
      }
      return Buffer.from(retry.data);
    }

    if (res.status >= 400) {
      throw new Error(`GET ${resolvedPath} (${res.status})`);
    }

    return Buffer.from(res.data);
  }
}
