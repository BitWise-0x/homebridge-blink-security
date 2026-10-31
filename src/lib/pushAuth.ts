import crypto from 'crypto';
import axios from 'axios';

/**
 * The Blink session push notifications are delivered to.
 *
 * Blink only pushes to Firebase tokens registered by clients of its Android
 * app; the plugin's own session is an iOS-app client, whose notification key
 * Blink treats as an Apple push token. Pushes therefore get a session of
 * their own, signed in as the Android app on Blink's hosted sign-in page: the
 * user signs in in a browser and hands back the address Blink redirects to,
 * so the plugin never sees a password or 2FA code for it.
 */

export const PUSH_OAUTH_CLIENT_ID = 'android';
export const PUSH_REDIRECT_URI = 'https://applinks.blink.com/signin/callback';
const OAUTH_AUTHORIZE_URL = 'https://api.oauth.blink.com/oauth/v2/authorize';
const OAUTH_TOKEN_URL = 'https://api.oauth.blink.com/oauth/token';
const TIER_INFO_URL =
  'https://rest-prod.immedia-semi.com/api/v1/users/tier_info';
// Blink's Cloudflare turns away default HTTP client agents.
const USER_AGENT = 'Blink/60.0 (Homebridge)';
// Renew this long before the access token expires.
const REFRESH_MARGIN_MS = 60_000;

export interface PushSessionData {
  hardwareId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tier: string;
  accountId: number;
  clientId: string;
}

/** A sign-in started but not finished: what finishing it needs. */
export interface PushSignInPending {
  hardwareId: string;
  state: string;
  verifier: string;
  createdAt: number;
}

export interface HttpResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export type PushHttp = (request: {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
}) => Promise<HttpResponse>;

/** Blink refused this session: a new sign-in is needed. */
export class PushSignInRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushSignInRequiredError';
  }
}

export const defaultPushHttp: PushHttp = async ({
  method,
  url,
  headers = {},
  form,
  json,
}) => {
  const res = await axios.request({
    method,
    url,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    data: form ? new URLSearchParams(form).toString() : json,
    timeout: 20_000,
    validateStatus: () => true,
  });
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    if (value !== undefined && value !== null) {
      flat[key.toLowerCase()] = String(value);
    }
  }
  return { status: res.status, data: res.data, headers: flat };
};

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function newSignInPending(now = Date.now()): PushSignInPending {
  return {
    hardwareId: crypto.randomUUID().toUpperCase(),
    state: base64url(crypto.randomBytes(32)),
    verifier: base64url(crypto.randomBytes(64)),
    createdAt: now,
  };
}

/** Blink's hosted sign-in page for the Android client. */
export function signInUrl(pending: PushSignInPending): string {
  const challenge = base64url(
    crypto.createHash('sha256').update(pending.verifier).digest()
  );
  const params = new URLSearchParams({
    client_id: PUSH_OAUTH_CLIENT_ID,
    redirect_uri: PUSH_REDIRECT_URI,
    response_type: 'code',
    scope: 'client',
    state: pending.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    hardware_id: pending.hardwareId,
    app_brand: 'blink',
    app_version: 'Version 60.0',
    device_brand: 'Homebridge',
    device_model: 'Homebridge Blink Security',
    device_os_version: 'Android 14',
    dark_mode: 'false',
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * The authorization code in the address Blink redirected to, if it answers
 * the pending sign-in. Undefined for anything else, including an address
 * from an older sign-in attempt.
 */
export function callbackCode(
  callback: string,
  pending: PushSignInPending
): string | undefined {
  let url: URL;
  try {
    url = new URL(callback.trim());
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'applinks.blink.com' ||
    url.pathname !== '/signin/callback'
  ) {
    return undefined;
  }
  const states = url.searchParams.getAll('state');
  const codes = url.searchParams.getAll('code');
  if (states.length !== 1 || states[0] !== pending.state) {
    return undefined;
  }
  if (codes.length !== 1 || !codes[0]) {
    return undefined;
  }
  return codes[0];
}

function tokenFields(
  data: unknown,
  previousRefresh?: string
): Pick<PushSessionData, 'accessToken' | 'refreshToken' | 'expiresAt'> {
  const body = (data ?? {}) as Record<string, unknown>;
  const access = body.access_token;
  const refresh = body.refresh_token ?? previousRefresh;
  if (typeof access !== 'string' || !access || typeof refresh !== 'string') {
    throw new Error('Blink token response is incomplete');
  }
  const expiresIn = Number(body.expires_in) || 3600;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/** Finish a sign-in: trade the code for a session and look up its client. */
export async function exchangeSignIn(
  http: PushHttp,
  code: string,
  pending: PushSignInPending
): Promise<PushSessionData> {
  const tokenRes = await http({
    method: 'POST',
    url: OAUTH_TOKEN_URL,
    form: {
      grant_type: 'authorization_code',
      redirect_uri: PUSH_REDIRECT_URI,
      code,
      code_verifier: pending.verifier,
      client_id: PUSH_OAUTH_CLIENT_ID,
      hardware_id: pending.hardwareId,
      scope: 'client',
      app_brand: 'blink',
    },
  });
  if (tokenRes.status !== 200) {
    throw new PushSignInRequiredError(
      `Blink refused the sign-in (HTTP ${tokenRes.status}); the link may have expired`
    );
  }
  const tokens = tokenFields(tokenRes.data);
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };

  const tierRes = await http({
    method: 'GET',
    url: TIER_INFO_URL,
    headers: auth,
  });
  const tierInfo = (tierRes.data ?? {}) as Record<string, unknown>;
  const tier = tierInfo.tier;
  const accountId = Number(tierInfo.account_id);
  if (tierRes.status !== 200 || typeof tier !== 'string' || !accountId) {
    throw new Error(`Blink tier lookup failed (HTTP ${tierRes.status})`);
  }

  const homeRes = await http({
    method: 'GET',
    url: `https://rest-${tier}.immedia-semi.com/api/v3/accounts/${accountId}/homescreen`,
    headers: auth,
  });
  const clientId = homeRes.headers['client-id'];
  if (homeRes.status !== 200 || !clientId) {
    throw new Error(
      `Blink did not report a client id for the push session (HTTP ${homeRes.status})`
    );
  }

  return {
    ...tokens,
    hardwareId: pending.hardwareId,
    tier,
    accountId,
    clientId,
  };
}

/** Requests made as the push session, renewing its token as needed. */
export class PushAuth {
  private renewal?: Promise<void>;

  constructor(
    private session: PushSessionData,
    private readonly http: PushHttp,
    private readonly onUpdate: (session: PushSessionData) => void
  ) {}

  get data(): PushSessionData {
    return this.session;
  }

  private async renew(): Promise<void> {
    // One renewal at a time: Blink rotates the refresh token, so two
    // concurrent renewals would leave one holding a dead token.
    if (!this.renewal) {
      this.renewal = (async () => {
        const res = await this.http({
          method: 'POST',
          url: OAUTH_TOKEN_URL,
          form: {
            grant_type: 'refresh_token',
            refresh_token: this.session.refreshToken,
            client_id: PUSH_OAUTH_CLIENT_ID,
            scope: 'client',
            hardware_id: this.session.hardwareId,
          },
        });
        if ([400, 401, 403].includes(res.status)) {
          throw new PushSignInRequiredError(
            `Blink ended the push session (HTTP ${res.status})`
          );
        }
        if (res.status !== 200) {
          throw new Error(`Blink token renewal failed (HTTP ${res.status})`);
        }
        this.session = {
          ...this.session,
          ...tokenFields(res.data, this.session.refreshToken),
        };
        this.onUpdate(this.session);
      })().finally(() => {
        this.renewal = undefined;
      });
    }
    return this.renewal;
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    json?: unknown,
    retried = false
  ): Promise<unknown> {
    if (Date.now() > this.session.expiresAt - REFRESH_MARGIN_MS) {
      await this.renew();
    }
    const res = await this.http({
      method,
      url: `https://rest-${this.session.tier}.immedia-semi.com${path}`,
      headers: {
        Authorization: `Bearer ${this.session.accessToken}`,
        'Client-Id': this.session.clientId,
      },
      json,
    });
    if (res.status === 401 && !retried) {
      await this.renew();
      return this.request(method, path, json, true);
    }
    if (res.status === 401) {
      throw new PushSignInRequiredError(
        'Blink refused the push session (HTTP 401)'
      );
    }
    if (res.status >= 400) {
      throw new Error(`${method} ${path} failed (HTTP ${res.status})`);
    }
    return res.data;
  }
}
