import { Logger } from 'homebridge';

import { BlinkClient } from './client.js';
import type { BlinkAuthClient } from './auth.js';
import { ExponentialBackoff, sleep } from './utils.js';

export class BlinkApi {
  readonly client: BlinkClient;
  private readonly log: Logger;
  private readonly _lockCache = new Map<string, Promise<unknown>>();

  constructor(authClient: BlinkAuthClient, log: Logger) {
    this.log = log;
    this.client = new BlinkClient(authClient, log);
  }

  // --- Homescreen ---

  async getAccountHomescreen(maxTTL = 30): Promise<HomescreenResponse> {
    return this.client.get<HomescreenResponse>(
      '/api/v3/accounts/{accountID}/homescreen',
      maxTTL
    );
  }

  // --- Camera APIs ---

  async getCameraStatus(
    networkID: number,
    cameraID: number,
    maxTTL = 3600
  ): Promise<CameraStatusResponse> {
    return this.client.get<CameraStatusResponse>(
      `/network/${networkID}/camera/${cameraID}/status`,
      maxTTL
    );
  }

  async updateCameraThumbnail(
    networkID: number,
    cameraID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/network/${networkID}/camera/${cameraID}/thumbnail`
    );
  }

  async updateCameraClip(
    networkID: number,
    cameraID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/network/${networkID}/camera/${cameraID}/clip`
    );
  }

  async updateOwlClip(
    networkID: number,
    owlID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/owls/${owlID}/clip`
    );
  }

  async updateDoorbellClip(
    networkID: number,
    doorbellID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/doorbells/${doorbellID}/clip`
    );
  }

  async updateCameraSettings(
    networkID: number,
    cameraID: number,
    settings: CameraSettings
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/network/${networkID}/camera/${cameraID}/update`,
      settings
    );
  }

  async enableCameraMotion(
    networkID: number,
    cameraID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/network/${networkID}/camera/${cameraID}/enable`
    );
  }

  async disableCameraMotion(
    networkID: number,
    cameraID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/network/${networkID}/camera/${cameraID}/disable`
    );
  }

  async getCameraLiveView(
    networkID: number,
    cameraID: number
  ): Promise<LiveViewResponse> {
    return this.client.post<LiveViewResponse>(
      `/api/v6/accounts/{accountID}/networks/${networkID}/cameras/${cameraID}/liveview`,
      { intent: 'liveview', motion_event_start_time: null }
    );
  }

  // --- Owl (Blink Mini) APIs ---

  async getOwlConfig(
    networkID: number,
    owlID: number,
    maxTTL = 3600
  ): Promise<CameraStatusResponse> {
    return this.client.get<CameraStatusResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/owls/${owlID}/config`,
      maxTTL
    );
  }

  async getOwlLiveView(
    networkID: number,
    owlID: number
  ): Promise<LiveViewResponse> {
    return this.client.post<LiveViewResponse>(
      `/api/v2/accounts/{accountID}/networks/${networkID}/owls/${owlID}/liveview`,
      { intent: 'liveview', motion_event_start_time: null }
    );
  }

  async updateOwlThumbnail(
    networkID: number,
    owlID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/owls/${owlID}/thumbnail`
    );
  }

  async updateOwlSettings(
    networkID: number,
    owlID: number,
    settings: OwlSettings
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/owls/${owlID}/config`,
      settings
    );
  }

  // --- Network APIs ---

  async armNetwork(networkID: number): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/state/arm`
    );
  }

  async disarmNetwork(networkID: number): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/state/disarm`
    );
  }

  async updateNetworkLvSave(
    networkID: number,
    lv_save: boolean
  ): Promise<CommandResponse> {
    // Try multiple endpoint/payload combinations — the working one varies by account
    const attempts: Array<{ path: string; body: unknown }> = [
      {
        path: `/network/${networkID}/update`,
        body: { lv_save },
      },
      {
        path: `/api/v1/accounts/{accountID}/networks/${networkID}/update`,
        body: { lv_save },
      },
      {
        path: `/network/${networkID}/update`,
        body: { network: { lv_save } },
      },
    ];

    for (const { path, body } of attempts) {
      try {
        return await this.client.post<CommandResponse>(path, body);
      } catch {
        // Try next combination
      }
    }
    throw new Error(`Failed to update lv_save for network ${networkID}`);
  }

  // --- Doorbell APIs ---

  async getDoorbellLiveView(
    networkID: number,
    doorbellID: number
  ): Promise<LiveViewResponse> {
    return this.client.post<LiveViewResponse>(
      `/api/v2/accounts/{accountID}/networks/${networkID}/doorbells/${doorbellID}/liveview`,
      { intent: 'liveview', motion_event_start_time: null }
    );
  }

  async getDoorbellConfig(
    networkID: number,
    doorbellID: number,
    maxTTL = 3600
  ): Promise<DoorbellConfigResponse> {
    return this.client.get<DoorbellConfigResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/doorbells/${doorbellID}/config`,
      maxTTL
    );
  }

  async updateDoorbellThumbnail(
    networkID: number,
    doorbellID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/doorbells/${doorbellID}/thumbnail`
    );
  }

  async enableDoorbellMotion(
    networkID: number,
    doorbellID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/doorbells/${doorbellID}/enable`
    );
  }

  async disableDoorbellMotion(
    networkID: number,
    doorbellID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/doorbells/${doorbellID}/disable`
    );
  }

  // --- Siren APIs ---

  async activateSiren(
    networkID: number,
    sirenID: number,
    durationSeconds = 30
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/sirens/${sirenID}/activate`,
      { duration: durationSeconds }
    );
  }

  async deactivateSirens(networkID: number): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/sirens/deactivate`
    );
  }

  // --- Camera Signals ---

  async getCameraSignals(
    networkID: number,
    cameraID: number,
    maxTTL = 300
  ): Promise<CameraSignalsResponse> {
    return this.client.get<CameraSignalsResponse>(
      `/network/${networkID}/camera/${cameraID}/signals`,
      maxTTL
    );
  }

  // --- Programs / Schedules ---

  async getPrograms(
    networkID: number,
    maxTTL = 3600
  ): Promise<ProgramsResponse> {
    return this.client.get<ProgramsResponse>(
      `/api/v1/networks/${networkID}/programs`,
      maxTTL
    );
  }

  async enableProgram(
    networkID: number,
    programID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/networks/${networkID}/programs/${programID}/enable`
    );
  }

  async disableProgram(
    networkID: number,
    programID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/networks/${networkID}/programs/${programID}/disable`
    );
  }

  // --- Notifications ---

  async getNotificationConfig(
    maxTTL = 3600
  ): Promise<NotificationConfigResponse> {
    return this.client.get<NotificationConfigResponse>(
      '/api/v1/accounts/{accountID}/notifications/configuration',
      maxTTL
    );
  }

  // --- Local Storage ---

  async requestLocalStorageManifest(
    networkID: number,
    syncModuleID: number
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      `/api/v1/accounts/{accountID}/networks/${networkID}/sync_modules/${syncModuleID}/local_storage/manifest/request`
    );
  }

  // --- Media ---

  async getMediaChange(maxTTL = 15): Promise<MediaChangeResponse> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.client.get<MediaChangeResponse>(
      `/api/v1/accounts/{accountID}/media/changed?since=${since}&page=0`,
      maxTTL
    );
  }

  async getMediaCount(maxTTL = 60): Promise<MediaCountResponse> {
    return this.client.get<MediaCountResponse>(
      '/api/v1/accounts/{accountID}/media/count',
      maxTTL
    );
  }

  // --- Account ---

  async getAccountOptions(maxTTL = 3600): Promise<AccountOptionsResponse> {
    return this.client.get<AccountOptionsResponse>(
      '/api/v1/account/options',
      maxTTL
    );
  }

  // --- Command ---

  async getCommand(
    networkID: number,
    commandID: number
  ): Promise<CommandStatusResponse> {
    return this.client.get<CommandStatusResponse>(
      `/network/${networkID}/command/${commandID}`,
      0
    );
  }

  async deleteCommand(networkID: number, commandID: number): Promise<unknown> {
    return this.client.post(`/network/${networkID}/command/${commandID}/done/`);
  }

  // --- Utility URL fetch ---

  async getUrl<T = unknown>(url: string): Promise<T> {
    return this.client.getUrl<T>(url);
  }

  async getBinary(url: string): Promise<Buffer> {
    return this.client.getBinary(url);
  }

  // --- Command execution helpers ---

  async commandWait(
    networkID: number,
    commandID: number | undefined,
    timeout?: number
  ): Promise<CommandStatusResponse | undefined> {
    if (!commandID) {
      return undefined;
    }

    const start = Date.now();
    let cmd = (await this.getCommand(networkID, commandID).catch(() => ({
      complete: false,
    }))) as CommandStatusResponse;

    while (cmd.complete === false) {
      await sleep(400);
      cmd = (await this.getCommand(networkID, commandID).catch(() => ({
        complete: false,
      }))) as CommandStatusResponse;

      if (timeout && Date.now() - start > timeout * 1000) {
        await this.deleteCommand(networkID, commandID).catch(() => undefined);
        break;
      }
    }

    return cmd;
  }

  async command(
    networkID: number,
    fn: () => Promise<CommandResponse>,
    timeout = 60
  ): Promise<CommandStatusResponse | undefined> {
    const start = Date.now();
    const backoff = new ExponentialBackoff(1000, 10000, 2);

    const tryCmd = async (): Promise<CommandResponse> => {
      try {
        return await fn();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only retry on "busy" — propagate all other errors (404, 401, etc.)
        if (/busy/i.test(msg)) {
          return { message: msg } as CommandResponse;
        }
        this.log.warn(`Command failed: ${msg}`);
        throw err;
      }
    };

    let cmd: CommandResponse;
    try {
      cmd = await tryCmd();
    } catch {
      return undefined;
    }
    while (cmd.message && /busy/i.test(cmd.message)) {
      const delayMs = backoff.delayMs;
      this.log.info(`Sleeping ${Math.round(delayMs / 1000)}s: ${cmd.message}`);
      await backoff.wait();
      if (Date.now() - start > timeout * 1000) {
        return undefined;
      }
      try {
        cmd = await tryCmd();
      } catch {
        return undefined;
      }
    }

    const remainingTimeout = timeout - (Date.now() - start) / 1000;
    const commandID =
      (cmd as CommandResponse).id ?? (cmd as CommandResponse).command_id;
    return this.commandWait(networkID, commandID, remainingTimeout);
  }

  async lock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this._lockCache.has(name)) {
      return this._lockCache.get(name) as Promise<T>;
    }

    const promise = fn();
    this._lockCache.set(name, promise);

    try {
      return await promise;
    } finally {
      this._lockCache.delete(name);
    }
  }
}

// --- API Response Types ---

export interface HomescreenResponse {
  networks: HomescreenNetwork[];
  sync_modules: SyncModule[];
  cameras: HomescreenCamera[];
  owls: HomescreenCamera[];
  sirens: HomescreenSiren[];
  chimes: unknown[];
  doorbell_buttons: HomescreenCamera[];
}

export interface HomescreenSiren {
  id: number;
  network_id: number;
  name: string;
  serial: string;
  fw_version: string;
  type: string;
  enabled: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface HomescreenNetwork {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  armed: boolean;
  lv_save?: boolean;
  status?: string;
  syncModule?: SyncModule;
}

export interface SyncModule {
  id: number;
  network_id: number;
  name: string;
  serial: string;
  fw_version: string;
  type: string;
  status: string;
  last_hb: string;
  wifi_strength: number;
}

export interface HomescreenCamera {
  id: number;
  network_id: number;
  name: string;
  serial: string;
  fw_version: string;
  type: string;
  enabled: boolean;
  thumbnail: string;
  status: string;
  battery?: string;
  signals?: { lfr?: number; wifi?: number; temp?: number; battery?: number };
  created_at: string;
  updated_at: string;
}

export interface CameraStatusResponse {
  camera_status?: {
    battery_voltage?: number;
    wifi_strength?: number;
  };
}

export interface DoorbellConfigResponse {
  id: number;
  network_id: number;
  name: string;
  serial: string;
  fw_version: string;
  type: string;
  enabled: boolean;
  thumbnail: string;
  status: string;
  battery?: string;
  signals?: { lfr?: number; wifi?: number; temp?: number; battery?: number };
  created_at: string;
  updated_at: string;
}

export interface CommandResponse {
  id?: number;
  command_id?: number;
  message?: string;
  server?: string;
  complete?: boolean;
}

export interface CommandStatusResponse {
  complete: boolean;
  status_msg?: string;
  id?: number;
  server?: string;
}

export interface LiveViewResponse {
  server?: string;
  id?: number;
  command_id?: number;
  message?: string;
  complete?: boolean;
}

export interface MediaChangeResponse {
  media: MediaEntry[];
}

export interface MediaEntry {
  id: number;
  created_at: string;
  updated_at: string;
  device_id: number;
  network_id: number;
  device: string;
  source?: string;
  thumbnail: string;
  media?: string;
}

export interface CameraSignalsResponse {
  lfr?: number;
  wifi?: number;
  temp?: number;
  battery?: number;
  battery_voltage?: number;
}

export interface ProgramsResponse {
  programs: ProgramEntry[];
}

export interface ProgramEntry {
  id: number;
  network_id: number;
  name: string;
  enabled: boolean;
  schedule: unknown[];
}

export interface NotificationConfigResponse {
  notifications?: {
    low_battery?: boolean;
    camera_offline?: boolean;
    camera_usage?: boolean;
    scheduling?: boolean;
    motion?: boolean;
    sync_module_offline?: boolean;
  };
}

export interface MediaCountResponse {
  count: number;
}

export interface AccountOptionsResponse {
  [key: string]: unknown;
}

export interface CameraSettings {
  motion_sensitivity?: number;
  illuminator_enable?: number; // 0=off, 1=on, 2=auto
  video_length?: number;
  early_termination?: boolean;
  alert_interval?: number;
  record_audio_enable?: boolean;
  video_quality?: string;
  illuminator_intensity?: number;
}

export interface OwlSettings {
  enabled?: boolean;
  motion_sensitivity?: number;
  video_length?: number;
  early_termination?: boolean;
  record_audio_enable?: boolean;
  video_quality?: string;
}
