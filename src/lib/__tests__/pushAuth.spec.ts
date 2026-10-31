import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  PushAuth,
  PushSignInRequiredError,
  callbackCode,
  newSignInPending,
  signInUrl,
  type PushHttp,
  type PushSessionData,
} from '../pushAuth.js';

describe('push sign-in link', () => {
  it('asks Blink for an Android-app session with PKCE', () => {
    const pending = newSignInPending();
    const url = new URL(signInUrl(pending));
    expect(url.origin + url.pathname).toBe(
      'https://api.oauth.blink.com/oauth/v2/authorize'
    );
    expect(url.searchParams.get('client_id')).toBe('android');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://applinks.blink.com/signin/callback'
    );
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('hardware_id')).toBe(pending.hardwareId);
    const expected = crypto
      .createHash('sha256')
      .update(pending.verifier)
      .digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
  });

  it('reads the code only from a callback that answers this sign-in', () => {
    const pending = newSignInPending();
    const base = 'https://applinks.blink.com/signin/callback';
    expect(
      callbackCode(`${base}?code=abc&state=${pending.state}`, pending)
    ).toBe('abc');
    expect(
      callbackCode(`  ${base}?state=${pending.state}&code=abc  `, pending)
    ).toBe('abc');
    expect(
      callbackCode(`${base}?code=abc&state=other`, pending)
    ).toBeUndefined();
    expect(
      callbackCode(
        `https://evil.example/signin/callback?code=abc&state=${pending.state}`,
        pending
      )
    ).toBeUndefined();
    expect(
      callbackCode(`${base}?state=${pending.state}`, pending)
    ).toBeUndefined();
    expect(callbackCode('not a url', pending)).toBeUndefined();
  });
});

describe('PushAuth', () => {
  const session: PushSessionData = {
    hardwareId: 'HW',
    accessToken: 'old',
    refreshToken: 'r1',
    expiresAt: 0,
    tier: 'e006',
    accountId: 1,
    clientId: '9',
  };

  it('renews an expired token once, stores the rotation and sends Client-Id', async () => {
    const http = vi.fn(
      async (req: { url: string; form?: Record<string, string> }) => {
        if (req.url.endsWith('/oauth/token')) {
          return {
            status: 200,
            data: {
              access_token: 'new',
              refresh_token: 'r2',
              expires_in: 3600,
            },
            headers: {},
          };
        }
        return { status: 200, data: { ok: true }, headers: {} };
      }
    );
    const onUpdate = vi.fn();
    const auth = new PushAuth(
      { ...session },
      http as unknown as PushHttp,
      onUpdate
    );
    await Promise.all([auth.request('GET', '/a'), auth.request('GET', '/b')]);
    const renewals = http.mock.calls.filter(c =>
      c[0].url.endsWith('/oauth/token')
    );
    expect(renewals).toHaveLength(1);
    expect(renewals[0][0].form).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      client_id: 'android',
      hardware_id: 'HW',
    });
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new', refreshToken: 'r2' })
    );
    expect(http).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://rest-e006.immedia-semi.com/a',
        headers: { Authorization: 'Bearer new', 'Client-Id': '9' },
      })
    );
  });

  it('reports a refused renewal as needing a new sign-in', async () => {
    const http = vi.fn(async () => ({ status: 400, data: {}, headers: {} }));
    const auth = new PushAuth(
      { ...session },
      http as unknown as PushHttp,
      vi.fn()
    );
    await expect(auth.request('GET', '/a')).rejects.toBeInstanceOf(
      PushSignInRequiredError
    );
  });
});
