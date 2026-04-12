import { Logger } from 'homebridge';

import {
  BlinkApi,
  type CameraSettings,
  type CommandResponse,
  type HomescreenCamera,
  type HomescreenSiren,
  type MediaEntry,
} from '../lib/api.js';
import type { BlinkAuthClient } from '../lib/auth.js';
import { BlinkNetwork, type NetworkData } from './network.js';
import { BlinkCamera } from './camera.js';
import { BlinkDoorbell } from './doorbell.js';
import { BlinkSiren } from './siren.js';
import { ExponentialBackoff } from '../lib/utils.js';

export { BlinkDevice } from './base.js';
export { BlinkNetwork } from './network.js';
export { BlinkCamera } from './camera.js';
export { BlinkDoorbell } from './doorbell.js';
export { BlinkSiren } from './siren.js';

export const THUMBNAIL_TTL = 60 * 60;
export const MOTION_POLL = 15;
export const STATUS_POLL = 30;
export const ARMED_DELAY = 60;
export const MOTION_TRIGGER_DECAY = 90;
export const DOORBELL_DEVICE_TYPE = 'lotus';

export class Blink {
  readonly api: BlinkApi;
  readonly log: Logger;
  networks = new Map<number, BlinkNetwork>();
  cameras = new Map<number, BlinkCamera>();
  doorbells = new Map<number, BlinkDoorbell>();
  sirens = new Map<number, BlinkSiren>();

  private readonly statusPoll: number;
  private readonly motionPoll: number;
  private readonly snapshotRate: number;

  constructor(
    authClient: BlinkAuthClient,
    log: Logger,
    statusPoll = STATUS_POLL,
    motionPoll = MOTION_POLL,
    snapshotRate = THUMBNAIL_TTL
  ) {
    this.api = new BlinkApi(authClient, log);
    this.log = log;
    this.statusPoll = statusPoll ?? STATUS_POLL;
    this.motionPoll = motionPoll ?? MOTION_POLL;
    this.snapshotRate = snapshotRate ?? THUMBNAIL_TTL;
  }

  protected createNetwork(data: NetworkData): BlinkNetwork {
    return new BlinkNetwork(data, this);
  }

  protected createCamera(data: HomescreenCamera): BlinkCamera {
    return new BlinkCamera(data, this);
  }

  protected createDoorbell(data: HomescreenCamera): BlinkDoorbell {
    return new BlinkDoorbell(data, this);
  }

  protected createSiren(data: HomescreenSiren): BlinkSiren {
    return new BlinkSiren(data, this);
  }

  async refreshData(force = false) {
    const ttl = force ? 0.1 : this.statusPoll;
    const homescreen = await this.api.getAccountHomescreen(ttl);

    const allCameras: HomescreenCamera[] = [
      ...(homescreen.cameras ?? []),
      ...(homescreen.owls ?? []),
    ];

    let allDoorbells: HomescreenCamera[] = [
      ...(homescreen.doorbells ?? []),
      ...(homescreen.doorbell_buttons ?? []),
    ];

    // Fallback: discover doorbells from recent media when homescreen has none
    if (allDoorbells.length === 0) {
      try {
        const mediaRes = await this.api
          .getMediaChange(ttl)
          .catch(() => ({ media: [] }));

        const doorbellIds = new Map<
          number,
          { network_id: number; thumbnail: string }
        >();
        for (const entry of mediaRes.media ?? []) {
          if (
            entry.device === DOORBELL_DEVICE_TYPE &&
            !doorbellIds.has(entry.device_id)
          ) {
            doorbellIds.set(entry.device_id, {
              network_id: entry.network_id,
              thumbnail: entry.thumbnail,
            });
          }
        }

        const fallbackDoorbells: HomescreenCamera[] = [];
        for (const [deviceId, { network_id, thumbnail }] of doorbellIds) {
          try {
            const config = await this.api.getDoorbellConfig(
              network_id,
              deviceId,
              ttl
            );
            // The config endpoint may return fields under different names
            // (e.g. camera_id instead of id) or nest them. Synthesize a
            // HomescreenCamera using known-good values from the media entry
            // and fill in what the config provides.
            const raw = config as unknown as Record<string, unknown>;
            const doorbell: HomescreenCamera = {
              id: (raw.id as number) ?? deviceId,
              network_id: (raw.network_id as number) ?? network_id,
              name: (raw.name as string) ?? `Doorbell ${deviceId}`,
              serial: (raw.serial as string) ?? '',
              fw_version: (raw.fw_version as string) ?? '',
              type: (raw.type as string) ?? DOORBELL_DEVICE_TYPE,
              enabled: (raw.enabled as boolean) ?? true,
              thumbnail: (raw.thumbnail as string) ?? thumbnail ?? '',
              status: (raw.status as string) ?? 'online',
              battery: raw.battery as string | undefined,
              signals: raw.signals as HomescreenCamera['signals'],
              created_at:
                (raw.created_at as string) ?? new Date().toISOString(),
              updated_at:
                (raw.updated_at as string) ?? new Date().toISOString(),
            };
            fallbackDoorbells.push(doorbell);
          } catch (err) {
            this.log.debug(
              `Failed to fetch config for doorbell ${deviceId}: ${err}`
            );
          }
        }

        if (fallbackDoorbells.length > 0) {
          this.log.info(
            `Blink fallback discovered ${fallbackDoorbells.length} doorbell(s) from recent media.`
          );
          allDoorbells = fallbackDoorbells;
        }
      } catch (err) {
        this.log.debug(`Doorbell fallback discovery failed: ${err}`);
      }

      // Second fallback: if media had no doorbell entries but we already
      // know about doorbells from a previous session, re-discover them
      // directly via the config endpoint.
      if (allDoorbells.length === 0 && this.doorbells.size > 0) {
        for (const [id, doorbell] of this.doorbells) {
          try {
            const config = await this.api.getDoorbellConfig(
              doorbell.networkID,
              id,
              ttl
            );
            const raw = config as unknown as Record<string, unknown>;
            const current = doorbell.data;
            const entry: HomescreenCamera = {
              id: current.id,
              network_id: current.network_id,
              name: (raw.name as string) ?? current.name,
              serial: (raw.serial as string) ?? current.serial,
              fw_version: (raw.fw_version as string) ?? current.fw_version,
              type: current.type,
              enabled: (raw.enabled as boolean) ?? current.enabled,
              thumbnail: (raw.thumbnail as string) ?? current.thumbnail,
              status: (raw.status as string) ?? current.status,
              battery: raw.battery as string | undefined,
              created_at: current.created_at,
              updated_at: (raw.updated_at as string) ?? current.updated_at,
            };
            allDoorbells.push(entry);
          } catch {
            // Config fetch failed — keep existing data as-is
            allDoorbells.push(doorbell.data);
          }
        }
        if (allDoorbells.length > 0) {
          this.log.info(
            `Blink fallback restored ${allDoorbells.length} doorbell(s) from cached state.`
          );
        }
      }
    }

    // Exclude fallback-discovered doorbells from camera list to prevent duplicates
    const doorbellIdSet = new Set(allDoorbells.map(d => d.id));
    const filteredCameras = allCameras.filter(c => !doorbellIdSet.has(c.id));

    const allSirens: HomescreenSiren[] = [...(homescreen.sirens ?? [])];

    for (const network of homescreen.networks) {
      (network as NetworkData).syncModule = homescreen.sync_modules.find(
        sm => sm.network_id === network.id
      );
    }

    if (this.networks.size > 0) {
      for (const n of homescreen.networks) {
        if (this.networks.has(n.id)) {
          this.networks.get(n.id)!.data = n as NetworkData;
        }
      }
      for (const c of filteredCameras) {
        if (this.cameras.has(c.id)) {
          this.cameras.get(c.id)!.data = c;
        }
      }
      for (const d of allDoorbells) {
        if (this.doorbells.has(d.id)) {
          this.doorbells.get(d.id)!.data = d;
        }
      }
      // Refresh fallback-discovered doorbells not present in homescreen
      for (const [id, doorbell] of this.doorbells) {
        if (!doorbellIdSet.has(id)) {
          try {
            const config = await this.api.getDoorbellConfig(
              doorbell.networkID,
              id,
              ttl
            );
            const raw = config as unknown as Record<string, unknown>;
            const current = doorbell.data;

            // Use thumbnail from config if available, otherwise check recent
            // media for a newer one (e.g. after a post-stream thumbnail refresh).
            let thumbnail = (raw.thumbnail as string) || current.thumbnail;
            const lastMedia = await this.getCameraLastMotion(
              doorbell.networkID,
              id
            ).catch(() => undefined);
            if (lastMedia?.thumbnail) {
              const mediaTime = Date.parse(lastMedia.created_at) || 0;
              if (mediaTime > doorbell.thumbnailCreatedAt || !thumbnail) {
                thumbnail = lastMedia.thumbnail;
              }
            }

            // Preserve synthesized id/network_id, update other fields
            doorbell.data = {
              ...current,
              name: (raw.name as string) ?? current.name,
              serial: (raw.serial as string) ?? current.serial,
              fw_version: (raw.fw_version as string) ?? current.fw_version,
              enabled: (raw.enabled as boolean) ?? current.enabled,
              status: (raw.status as string) ?? current.status,
              battery: raw.battery as string | undefined,
              thumbnail,
              updated_at: (raw.updated_at as string) ?? current.updated_at,
            };
          } catch {
            // Config fetch failed — keep existing data
          }
        }
      }
      for (const s of allSirens) {
        if (this.sirens.has(s.id)) {
          this.sirens.get(s.id)!.data = s;
        }
      }
    } else {
      this.networks = new Map(
        homescreen.networks.map(n => [
          n.id,
          this.createNetwork(n as NetworkData),
        ])
      );
      this.cameras = new Map(
        filteredCameras.map(c => [c.id, this.createCamera(c)])
      );
      this.doorbells = new Map(
        allDoorbells.map(d => [d.id, this.createDoorbell(d)])
      );
      this.sirens = new Map(allSirens.map(s => [s.id, this.createSiren(s)]));
    }

    // Check for doorbell press events
    for (const doorbell of this.doorbells.values()) {
      await doorbell.checkForPress().catch(err => {
        this.log.debug(`Doorbell press check failed: ${err}`);
      });
    }

    return homescreen;
  }

  async setArmedState(networkID: number, arm = true): Promise<void> {
    const cmd = arm
      ? () => this.api.armNetwork(networkID)
      : () => this.api.disarmNetwork(networkID);

    await this.api.lock(`setArmedState(${networkID})`, async () => {
      await this.api.command(networkID, cmd);
    });

    await this.refreshData(true);
  }

  async setCameraMotionSensorState(
    networkID: number,
    cameraID: number,
    enabled = true
  ): Promise<void> {
    const camera = this.cameras.get(cameraID);

    let cmd: () => Promise<CommandResponse>;
    if (camera?.isCameraMini) {
      cmd = () => this.api.updateOwlSettings(networkID, cameraID, { enabled });
    } else if (enabled) {
      cmd = () => this.api.enableCameraMotion(networkID, cameraID);
    } else {
      cmd = () => this.api.disableCameraMotion(networkID, cameraID);
    }

    await this.api.lock(
      `setCameraMotionSensorState(${networkID}, ${cameraID})`,
      async () => {
        await this.api.command(networkID, cmd);
      }
    );

    await this.refreshData(true);
  }

  async recordCameraClip(networkID: number, cameraID: number): Promise<void> {
    const camera = this.cameras.get(cameraID);
    const doorbell = this.doorbells.get(cameraID);

    let cmd: () => Promise<CommandResponse>;
    if (camera?.isCameraMini) {
      cmd = () => this.api.updateOwlClip(networkID, cameraID);
    } else if (doorbell) {
      cmd = () => this.api.updateDoorbellClip(networkID, cameraID);
    } else {
      cmd = () => this.api.updateCameraClip(networkID, cameraID);
    }

    await this.api.lock(
      `recordCameraClip(${networkID}, ${cameraID})`,
      async () => {
        await this.api.command(networkID, cmd);
      }
    );
  }

  async updateCameraSettings(
    networkID: number,
    cameraID: number,
    settings: CameraSettings
  ): Promise<void> {
    await this.api.lock(
      `updateCameraSettings(${networkID}, ${cameraID})`,
      async () => {
        await this.api.command(networkID, () =>
          this.api.updateCameraSettings(networkID, cameraID, settings)
        );
      }
    );
  }

  async activateSiren(
    networkID: number,
    sirenID: number,
    durationSeconds = 30
  ): Promise<void> {
    await this.api.lock(`activateSiren(${networkID}, ${sirenID})`, async () => {
      await this.api.command(networkID, () =>
        this.api.activateSiren(networkID, sirenID, durationSeconds)
      );
    });
  }

  async deactivateSirens(networkID: number): Promise<void> {
    await this.api.lock(`deactivateSirens(${networkID})`, async () => {
      await this.api.command(networkID, () =>
        this.api.deactivateSirens(networkID)
      );
    });
  }

  async setDoorbellMotionSensorState(
    networkID: number,
    doorbellID: number,
    enabled = true
  ): Promise<void> {
    const cmd = enabled
      ? () => this.api.enableDoorbellMotion(networkID, doorbellID)
      : () => this.api.disableDoorbellMotion(networkID, doorbellID);

    await this.api.lock(
      `setDoorbellMotionSensorState(${networkID}, ${doorbellID})`,
      async () => {
        await this.api.command(networkID, cmd);
      }
    );

    await this.refreshData(true);
  }

  async refreshCameraThumbnail(
    networkID?: number,
    cameraID?: number,
    force = false
  ): Promise<void> {
    const cameras = [...this.cameras.values()]
      .filter(camera => !networkID || camera.networkID === networkID)
      .filter(camera => !cameraID || camera.cameraID === cameraID);

    const status = await Promise.all(
      cameras.map(async camera => {
        const ttl = force ? 500 : this.snapshotRate * 1000;
        const lastSnapshot = camera.thumbnailCreatedAt + ttl;
        const eligible = force || (camera.armed && camera.enabled);

        if (eligible && Date.now() >= lastSnapshot) {
          if (camera.lowBattery || !camera.online) {
            this.log.info(
              `${camera.name} - ${!camera.online ? 'Offline' : 'Low Battery'}; Skipping snapshot`
            );
            return false;
          }

          camera.thumbnailCreatedAt = Date.now();

          const updateCamera = camera.isCameraMini
            ? () =>
                this.api.updateOwlThumbnail(camera.networkID, camera.cameraID)
            : () =>
                this.api.updateCameraThumbnail(
                  camera.networkID,
                  camera.cameraID
                );

          await this.api.lock(
            `refreshCameraThumbnail(${camera.networkID}, ${camera.cameraID})`,
            async () => {
              await this.api.command(camera.networkID, updateCamera);
            }
          );

          return true;
        }
        return false;
      })
    );

    if (status.includes(true)) {
      await this.refreshData(true);
    }
  }

  async getCameraLastMotion(
    networkID: number,
    cameraID?: number
  ): Promise<MediaEntry | undefined> {
    const res = await this.api
      .getMediaChange(this.motionPoll)
      .catch(() => ({ media: [] }));
    const media = (res.media || [])
      .filter(m => !networkID || m.network_id === networkID)
      .filter(m => !cameraID || m.device_id === cameraID)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return media[0];
  }

  async getCameraLastThumbnail(
    networkID: number,
    cameraID: number
  ): Promise<string | undefined> {
    const camera = this.cameras.get(cameraID);
    if (!camera) {
      return undefined;
    }

    if (camera.thumbnailCreatedAt > camera.updatedAt - 60 * 1000) {
      return camera.thumbnail;
    }

    const latestMedia = await this.getCameraLastMotion(networkID, cameraID);
    if (
      latestMedia?.created_at &&
      Date.parse(latestMedia.created_at) > camera.thumbnailCreatedAt
    ) {
      return latestMedia.thumbnail;
    }
    return camera.thumbnail;
  }

  async getCameraLiveView(networkID: number, cameraID: number, timeout = 30) {
    const camera = this.cameras.get(cameraID);

    // Liveview POST returns the server URL immediately in the response.
    // Unlike other commands, we do NOT poll for completion — the command
    // stays "incomplete" while the stream is active. Polling would just
    // wait until timeout and discard the server URL.
    const fn = camera?.isCameraMini
      ? () => this.api.getOwlLiveView(networkID, cameraID)
      : () => this.api.getCameraLiveView(networkID, cameraID);

    const start = Date.now();
    const backoff = new ExponentialBackoff(1000, 10000, 2);
    let response = await fn();

    // Retry on "busy" (409) just like command() does
    while (
      response.message &&
      /busy/i.test(response.message) &&
      Date.now() - start < timeout * 1000
    ) {
      const delayMs = backoff.delayMs;
      this.log.info(
        `Sleeping ${Math.round(delayMs / 1000)}s: ${response.message}`
      );
      await backoff.wait();
      response = await fn();
    }

    return response;
  }

  async getDoorbellLiveView(
    networkID: number,
    doorbellID: number,
    timeout = 30
  ) {
    const fn = () => this.api.getDoorbellLiveView(networkID, doorbellID);

    const start = Date.now();
    const backoff = new ExponentialBackoff(1000, 10000, 2);
    let response = await fn();

    while (
      response.message &&
      /busy/i.test(response.message) &&
      Date.now() - start < timeout * 1000
    ) {
      const delayMs = backoff.delayMs;
      this.log.info(
        `Sleeping ${Math.round(delayMs / 1000)}s: ${response.message}`
      );
      await backoff.wait();
      response = await fn();
    }

    return response;
  }

  async refreshDoorbellThumbnail(
    networkID: number,
    doorbellID: number,
    force = false
  ): Promise<void> {
    const doorbell = this.doorbells.get(doorbellID);
    if (!doorbell) {
      return;
    }

    const ttl = force ? 500 : this.snapshotRate * 1000;
    const lastSnapshot = doorbell.thumbnailCreatedAt + ttl;
    const eligible = force || (doorbell.armed && doorbell.enabled);

    if (eligible && Date.now() >= lastSnapshot) {
      if (!doorbell.online) {
        this.log.info(`${doorbell.name} - Offline; Skipping snapshot`);
        return;
      }

      doorbell.thumbnailCreatedAt = Date.now();

      await this.api.lock(
        `refreshDoorbellThumbnail(${networkID}, ${doorbellID})`,
        async () => {
          await this.api.command(networkID, () =>
            this.api.updateDoorbellThumbnail(networkID, doorbellID)
          );
        }
      );

      await this.refreshData(true);
    }
  }
}
