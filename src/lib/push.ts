import fs from 'fs';
import path from 'path';
import { Logger } from 'homebridge';
import pushReceiverModule from '@eneris/push-receiver';
import type * as Types from '@eneris/push-receiver/dist/types.js';

import {
  PushAuth,
  PushSignInRequiredError,
  callbackCode,
  defaultPushHttp,
  exchangeSignIn,
  newSignInPending,
  signInUrl,
  type PushHttp,
  type PushSessionData,
  type PushSignInPending,
} from './pushAuth.js';

/**
 * Blink push notifications, the channel the Blink app itself is told about
 * events on. Unlike the cloud media list, a push arrives for a doorbell press
 * whether or not the account has a subscription (no clip is needed), and it
 * arrives as soon as the button is pressed instead of after a clip uploads.
 *
 * The receiver registers a Firebase Cloud Messaging web-push token with the
 * Blink app's public Firebase project, then tells Blink to deliver the
 * notifications of a dedicated Android-app session (see pushAuth.ts) to that
 * token. The protocol is unofficial and was
 * worked out by ha-blink-live-events and ha-blink-instant-events.
 */

// Public Firebase client identifiers of the Blink Android app (not secrets).
export const BLINK_FIREBASE_CONFIG = {
  projectId: 'blink-6c1ea',
  appId: '1:351117235468:android:14fb3ef63df2a7c2',
  apiKey: 'AIzaSyBcgwrpglzCZJPUNNeQQnpBbJAFlas_XAI',
  messagingSenderId: '351117235468',
};

export const PUSH_CLIENT_NAME = 'Homebridge Blink Security';
// App version reported when registering for push notifications: the value
// the Blink Android app sends, which Blink accepts for client updates.
const PUSH_APP_VERSION = '60.0 (29834864)';

// Persistent ids are how the push server knows which messages were already
// delivered; only the recent ones matter.
const MAX_PERSISTENT_IDS = 100;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

const DOORBELL_EVENT_TYPES = ['button_press'];

export interface BlinkPushEvent {
  category?: string;
  eventType?: string;
  cameraId?: number;
  networkId?: number;
  cameraName?: string;
  createdAt?: string;
  uniqueId?: string;
  returnReceipt: boolean;
  /** Every field found, for logging unrecognized payloads. */
  raw: Record<string, unknown>;
}

interface PersistedPushState {
  credentials?: Types.Credentials;
  persistentIds?: string[];
  session?: PushSessionData;
  pending?: PushSignInPending;
}

export interface PushListenerOptions {
  /** The address Blink redirected to after the hosted sign-in. */
  signInCallback?: string;
  receiverFactory?: ReceiverFactory;
  http?: PushHttp;
}

interface ReceiverLike {
  onCredentialsChanged(
    listener: (data: Types.EventChangeCredentials) => void
  ): unknown;
  onNotification(listener: (data: Types.MessageEnvelope) => void): unknown;
  connect(): Promise<void>;
  destroy(): void;
  readonly fcmToken: string;
  persistentIds: string[];
}

export type ReceiverFactory = (config: Types.ClientConfig) => ReceiverLike;

const defaultReceiverFactory: ReceiverFactory = config => {
  const mod = pushReceiverModule as unknown as {
    PushReceiver?: new (c: Types.ClientConfig) => ReceiverLike;
    default?: { PushReceiver?: new (c: Types.ClientConfig) => ReceiverLike };
  };
  const Ctor = mod.PushReceiver ?? mod.default?.PushReceiver;
  if (!Ctor) {
    throw new Error('@eneris/push-receiver did not export PushReceiver');
  }
  return new Ctor(config);
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function toText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

/**
 * Flatten a push into one object. Blink's JSON can sit at the top of the
 * data, or be nested (often as a JSON string) under data, payload, message or
 * notification, depending on the delivery path.
 */
export function flattenPushData(
  input: unknown,
  depth = 0
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (depth > 4 || input === null || input === undefined) {
    return out;
  }
  let value: unknown = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return out;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return out;
  }
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (['data', 'payload', 'message', 'notification'].includes(key)) {
      const nested = flattenPushData(field, depth + 1);
      if (Object.keys(nested).length > 0) {
        Object.assign(out, nested);
        continue;
      }
    }
    if (!(key in out)) {
      out[key] = field;
    }
  }
  return out;
}

export function parseBlinkPush(
  envelope: Types.MessageEnvelope
): BlinkPushEvent {
  const raw = flattenPushData(envelope?.message ?? {});
  const receipt = raw.return_receipt;
  return {
    category: toText(raw.category),
    eventType: toText(raw.event_type ?? raw.type),
    cameraId: toNumber(raw.camera_id ?? raw.device_id ?? raw.camera),
    networkId: toNumber(raw.network_id ?? raw.network),
    cameraName: toText(raw.camera_name ?? raw.device_name),
    createdAt: toText(raw.created_at),
    uniqueId: toText(raw.unique_id ?? raw.transaction_id),
    returnReceipt:
      receipt === true ||
      receipt === 'true' ||
      receipt === 1 ||
      receipt === '1',
    raw,
  };
}

export function isDoorbellPress(event: BlinkPushEvent): boolean {
  return (
    event.eventType !== undefined &&
    DOORBELL_EVENT_TYPES.includes(event.eventType)
  );
}

export class BlinkPushListener {
  private receiver?: ReceiverLike;
  private state: PersistedPushState = {};
  private readonly stateFile: string;
  private retryMs = RETRY_MIN_MS;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private associatedToken?: string;
  private auth?: PushAuth;
  private readonly receiverFactory: ReceiverFactory;
  private readonly http: PushHttp;

  constructor(
    private readonly log: Logger,
    storagePath: string,
    private readonly onEvent: (event: BlinkPushEvent) => void,
    private readonly options: PushListenerOptions = {}
  ) {
    this.stateFile = path.join(storagePath, 'blink', 'push.json');
    this.receiverFactory = options.receiverFactory ?? defaultReceiverFactory;
    this.http = options.http ?? defaultPushHttp;
  }

  /** True once a push session exists (signed in). */
  get signedIn(): boolean {
    return this.state.session !== undefined;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.loadState();
    if (!(await this.ensureSession())) {
      return;
    }
    try {
      await this.connect();
      this.retryMs = RETRY_MIN_MS;
    } catch (err) {
      if (err instanceof PushSignInRequiredError) {
        this.requireSignIn(err.message);
        return;
      }
      this.log.warn(
        `Blink push notifications unavailable, retrying in ${Math.round(
          this.retryMs / 1000
        )}s: ${err instanceof Error ? err.message : String(err)}`
      );
      this.scheduleRetry();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    try {
      this.receiver?.destroy();
    } catch {
      /* best effort on the way out */
    }
    this.receiver = undefined;
  }

  /**
   * Make sure there is a push session, finishing a hosted sign-in when the
   * user has supplied its callback address. Returns false, after telling
   * the user what to do, when a sign-in is still needed.
   */
  private async ensureSession(): Promise<boolean> {
    if (!this.state.session) {
      const pending = this.state.pending;
      const callback = this.options.signInCallback?.trim();
      if (pending && callback) {
        const code = callbackCode(callback, pending);
        if (!code) {
          this.log.warn(
            'Blink push: the sign-in address in "push-sign-in-callback" does not ' +
              'answer the current sign-in link (it may be from an older attempt).'
          );
        } else {
          try {
            this.state.session = await exchangeSignIn(this.http, code, pending);
            this.state.pending = undefined;
            this.saveState();
            this.log.info(
              'Blink push: signed in. You can clear "push-sign-in-callback" now.'
            );
          } catch (err) {
            this.log.warn(
              `Blink push: sign-in could not be completed: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            // The code is single use: start over with a fresh link.
            this.state.pending = undefined;
          }
        }
      }
    }
    if (!this.state.session) {
      this.requireSignIn();
      return false;
    }
    this.auth = new PushAuth(this.state.session, this.http, session => {
      this.state.session = session;
      this.saveState();
    });
    return true;
  }

  /** Drop any session and tell the user how to sign in. */
  private requireSignIn(reason?: string): void {
    this.receiver?.destroy();
    this.receiver = undefined;
    this.auth = undefined;
    this.state.session = undefined;
    if (!this.state.pending) {
      this.state.pending = newSignInPending();
    }
    this.saveState();
    this.log.warn(
      `Blink push notifications need a one-time sign-in${reason ? ` (${reason})` : ''}. ` +
        'Open this link in a browser and sign in to Blink:\n' +
        `${signInUrl(this.state.pending)}\n` +
        'Blink then opens an address starting with ' +
        'https://applinks.blink.com/signin/callback (the page itself may not load). ' +
        'Copy that full address into the plugin setting "Push sign-in callback" ' +
        '(push-sign-in-callback) and restart the plugin.'
    );
  }

  private scheduleRetry(): void {
    if (this.stopped) {
      return;
    }
    this.receiver?.destroy();
    this.receiver = undefined;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.start();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private async connect(): Promise<void> {
    const receiver = this.receiverFactory({
      firebase: BLINK_FIREBASE_CONFIG,
      credentials: this.state.credentials,
      persistentIds: this.state.persistentIds ?? [],
    });
    this.receiver = receiver;

    receiver.onCredentialsChanged(({ newCredentials }) => {
      this.state.credentials = newCredentials;
      this.saveState();
      this.log.debug('Blink push: new push credentials registered');
      // Rotated token: Blink must be told about it again.
      if (newCredentials?.fcm?.token !== this.associatedToken) {
        void this.associate().catch(err => this.onBackgroundError(err));
      }
    });

    receiver.onNotification(envelope => this.handle(envelope));

    await receiver.connect();
    await this.associate();
    this.log.info('Blink push notifications connected');
  }

  private onBackgroundError(err: unknown): void {
    if (err instanceof PushSignInRequiredError) {
      this.requireSignIn(err.message);
    } else {
      this.log.warn(`Blink push: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Tell Blink to send the push session's notifications to our token. */
  private async associate(): Promise<void> {
    const token = this.receiver?.fcmToken || this.state.credentials?.fcm?.token;
    if (!token) {
      throw new Error('no push token was issued');
    }
    if (!this.auth) {
      throw new PushSignInRequiredError('not signed in');
    }
    const clientId = this.auth.data.clientId;
    await this.auth.request(
      'POST',
      `/clients/${encodeURIComponent(clientId)}/update`,
      {
        app_version: PUSH_APP_VERSION,
        os_version: '14',
        client_name: PUSH_CLIENT_NAME,
        notification_key: token,
      }
    );
    this.associatedToken = token;
    this.log.debug(
      `Blink push: token registered with Blink client ${clientId}`
    );
  }

  private handle(envelope: Types.MessageEnvelope): void {
    if (envelope?.persistentId) {
      const ids = this.state.persistentIds ?? [];
      ids.push(envelope.persistentId);
      this.state.persistentIds = ids.slice(-MAX_PERSISTENT_IDS);
      this.saveState();
    }

    let event: BlinkPushEvent;
    try {
      event = parseBlinkPush(envelope);
    } catch (err) {
      this.log.debug(`Blink push: unreadable message: ${err}`);
      return;
    }
    this.log.debug(
      `Blink push: category=${event.category} event_type=${event.eventType} ` +
        `camera_id=${event.cameraId} camera_name=${event.cameraName} ` +
        `fields=${Object.keys(event.raw).sort().join(',')}`
    );

    if (event.returnReceipt && event.uniqueId && this.auth) {
      void this.auth
        .request('POST', '/api/v2/notification', {
          transaction_id: event.uniqueId,
          status: 'RECEIVED',
        })
        .catch(err => this.log.debug(`Blink push: receipt failed: ${err}`));
    }

    try {
      this.onEvent(event);
    } catch (err) {
      this.log.warn(`Blink push: event handler failed: ${err}`);
    }
  }

  private loadState(): void {
    try {
      const text = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(text) as PersistedPushState;
      if (parsed && typeof parsed === 'object') {
        this.state = parsed;
      }
    } catch {
      this.state = {};
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.log.debug(`Blink push: could not save state: ${err}`);
    }
  }
}
