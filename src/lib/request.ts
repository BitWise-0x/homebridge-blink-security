// --- OAuth v2 + PKCE Constants ---

export const OAUTH_BASE_URL = 'https://api.oauth.blink.com';
export const OAUTH_AUTHORIZE_PATH = '/oauth/v2/authorize';
export const OAUTH_SIGNIN_PATH = '/oauth/v2/signin';
export const OAUTH_2FA_VERIFY_PATH = '/oauth/v2/2fa/verify';
export const OAUTH_TOKEN_PATH = '/oauth/token';

export const OAUTH_CLIENT_ID = 'ios';
export const OAUTH_SCOPE = 'client';
export const OAUTH_REDIRECT_URI =
  'immedia-blink://applinks.blink.com/signin/callback';
export const OAUTH_RESPONSE_TYPE = 'code';
export const OAUTH_CODE_CHALLENGE_METHOD = 'S256';

// --- Blink API Constants ---

export const BLINK_API_HOST = 'immedia-semi.com';
export const BLINK_API_DEFAULT_REGION = 'prod';
export const BLINK_TIER_INFO_PATH = '/api/v1/users/tier_info';

export function getRegionBaseURL(region: string): string {
  return `https://rest-${region}.${BLINK_API_HOST}`;
}

// --- Client Identity ---

export const APP_VERSION = '50.1';
export const APP_BRAND = 'blink';
export const DEVICE_BRAND = 'Apple';
export const DEVICE_IDENTIFIER = 'iPhone16,1';
export const OS_VERSION = '26.1';

// --- OAuth Browser Headers (matches blinkpy's Safari UA for OAuth flow) ---

export const OAUTH_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
export const OAUTH_SIGNIN_URL = `${OAUTH_BASE_URL}${OAUTH_SIGNIN_PATH}`;
export const OAUTH_TOKEN_USER_AGENT =
  'Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0';

// --- Default Headers (for authenticated Blink API calls) ---
// blinkpy only sends Authorization + Content-Type for API calls.
// APP-BUILD and User-Agent are intentionally omitted — they cause 426 errors.

export const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: '*/*',
};

// --- Token Lifecycle ---

export const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
