import { spawn, type ChildProcess } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  type CameraController,
  type CameraStreamingDelegate,
  type HAP,
  Logger,
  type PrepareStreamCallback,
  type PrepareStreamRequest,
  type PrepareStreamResponse,
  type SnapshotRequest,
  type SnapshotRequestCallback,
  type StreamingRequest,
  type StreamRequestCallback,
  StreamRequestTypes,
  type VideoInfo,
} from 'homebridge';

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  getDefaultIpAddress,
  reservePorts,
} = require('@homebridge/camera-utils');
const pathToFfmpeg: string = require('ffmpeg-for-homebridge');

import type { BlinkCamera } from '../devices/camera.js';
import { Http2TLSTunnel, ImmiTunnel } from '../lib/proxy.js';

interface SessionInfo {
  address: string;
  videoPort: number;
  videoCryptoSuite: number;
  videoSRTP: Buffer;
  videoSSRC: number;
}

interface ProxySession {
  path?: string;
  protocol?: string;
  host?: string;
  listenPort?: number;
  proxyServer?: Http2TLSTunnel | ImmiTunnel;
  isImmi?: boolean;
}

export class BlinkCameraDelegate implements CameraStreamingDelegate {
  private readonly blinkCamera: BlinkCamera;
  private readonly log: Logger;
  private readonly hap: HAP;
  private readonly liveViewEnabled: boolean;
  controller?: CameraController;
  private pendingSessions = new Map<string, SessionInfo>();
  private proxySessions = new Map<string, ProxySession>();
  private ongoingSessions = new Map<string, ChildProcess>();
  private streamTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private lastForcedRefresh = 0;

  constructor(
    blinkCamera: BlinkCamera,
    log: Logger,
    hap: HAP,
    liveViewEnabled = true
  ) {
    this.blinkCamera = blinkCamera;
    this.log = log;
    this.hap = hap;
    this.liveViewEnabled = liveViewEnabled;
  }

  async handleSnapshotRequest(
    request: SnapshotRequest,
    callback: SnapshotRequestCallback
  ): Promise<void> {
    this.log.debug(
      `${this.blinkCamera.name} - handleSnapshotRequest(${request.width}x${request.height})`
    );

    try {
      const bytes = await this.blinkCamera.getThumbnail();
      const size = bytes ? bytes.length : 0;
      if (size === 0) {
        const url = this.blinkCamera.thumbnail;
        this.log.warn(
          `${this.blinkCamera.name} - Snapshot: 0 bytes (${request.width}x${request.height}) — ${url ? `URL: ${url}` : 'no thumbnail URL'}`
        );
      } else {
        this.log.info(
          `${this.blinkCamera.name} - Snapshot: ${size} bytes (${request.width}x${request.height})`
        );
      }
      callback(undefined, bytes ?? Buffer.alloc(0));

      // Refresh thumbnail in background for next request
      // Force when empty, but rate-limit to once per 5 minutes to avoid 409 conflicts
      const shouldForce =
        size === 0 && Date.now() - this.lastForcedRefresh > 300_000;
      if (shouldForce) {
        this.lastForcedRefresh = Date.now();
      }
      this.blinkCamera
        .refreshThumbnail(shouldForce)
        .catch(e =>
          this.log.error(`${this.blinkCamera.name} - Refresh error:`, e)
        );
    } catch (err) {
      this.log.error(`${this.blinkCamera.name} - Snapshot error:`, err);
      // Return empty buffer instead of error — returning an error causes HomeKit to mark the accessory as unresponsive
      callback(undefined, Buffer.alloc(0));
    }
  }

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback
  ): Promise<void> {
    this.log.debug(`${this.blinkCamera.name} - prepareStream()`);

    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();
    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      videoPort: request.video.port,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([
        request.video.srtp_key,
        request.video.srtp_salt,
      ]),
      videoSSRC,
    };

    const response: PrepareStreamResponse = {
      addressOverride: await getDefaultIpAddress(
        request.addressVersion === 'ipv6'
      ),
      video: {
        port: request.video.port,
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: request.audio
        ? {
            port: request.audio.port,
            ssrc: audioSSRC,
            srtp_key: request.audio.srtp_key,
            srtp_salt: request.audio.srtp_salt,
          }
        : undefined,
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);
    this.proxySessions.set(request.sessionID, { path: undefined });

    let liveViewURL: string | undefined;
    if (this.liveViewEnabled) {
      try {
        liveViewURL = await this.blinkCamera.getLiveViewURL(30);
      } catch (err) {
        this.log.warn(
          `${this.blinkCamera.name} - LiveView request failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    this.log.info(
      `${this.blinkCamera.name} - LiveView: ${liveViewURL ?? 'unavailable'}`
    );

    const urlRegex = /([a-z]+):\/\/([^:/]+)(?::[0-9]+)?(\/.*)/;
    if (liveViewURL?.startsWith('immis') && urlRegex.test(liveViewURL)) {
      // IMMI protocol — MPEG-TS over TLS
      const [, protocol, host, path] = urlRegex.exec(liveViewURL)!;
      // Extract connectionId, serial, and clientId from the IMMI URL
      // URL format: immis://HOST:443/CONNECTION_ID__IMDS_SERIAL?client_id=CAMERA_ID
      const pathWithoutQuery = path.split('?')[0].replace(/^\//, '');
      const connectionId = pathWithoutQuery.replace(/__.*$/, '');
      const imdsMatch = pathWithoutQuery.match(/__IMDS_(.+)$/);
      const serial = imdsMatch ? imdsMatch[1].substring(0, 16) : '';
      const clientIdParam = new URL(
        liveViewURL.replace('immis://', 'https://')
      ).searchParams.get('client_id');
      const clientId = clientIdParam ? parseInt(clientIdParam, 10) : 0;
      const [listenPort] = await reservePorts({ count: 1 });
      const proxyServer = await this.createImmiTunnel(
        listenPort,
        host,
        clientId,
        connectionId,
        serial
      );
      this.proxySessions.set(request.sessionID, {
        protocol,
        host,
        path,
        listenPort,
        proxyServer,
        isImmi: true,
      });
    } else if (liveViewURL?.startsWith('rtsp') && urlRegex.test(liveViewURL)) {
      // RTSP protocol — TLS tunnel
      const [, protocol, host, path] = urlRegex.exec(liveViewURL)!;
      const [listenPort] = await reservePorts({ count: 1 });
      const proxyServer = await this.createTLSTunnel(
        listenPort,
        host,
        protocol
      );
      this.proxySessions.set(request.sessionID, {
        protocol,
        host,
        path,
        listenPort,
        proxyServer,
      });
    } else if (liveViewURL) {
      this.proxySessions.set(request.sessionID, { path: liveViewURL });
    } else {
      // No live view — save thumbnail to temp file as static fallback
      try {
        const thumbnail = await this.blinkCamera.getThumbnail();
        if (thumbnail && thumbnail.length > 0) {
          const tmpPath = join(
            tmpdir(),
            `blink-snapshot-${request.sessionID}.jpg`
          );
          await writeFile(tmpPath, thumbnail);
          this.proxySessions.set(request.sessionID, { path: tmpPath });
        }
      } catch (err) {
        this.log.warn(
          `${this.blinkCamera.name} - Thumbnail fallback failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    callback(undefined, response);
  }

  async handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback
  ): Promise<void> {
    this.log.debug(`${this.blinkCamera.name} - handleStreamRequest()`);

    if (request.type === StreamRequestTypes.START) {
      await this.startStream(request.sessionID, request.video);
    } else if (request.type === StreamRequestTypes.STOP) {
      await this.stopStream(request.sessionID);
    }
    callback();
  }

  private async startStream(
    sessionID: string,
    video: VideoInfo
  ): Promise<void> {
    const sessionInfo = this.pendingSessions.get(sessionID);
    if (!sessionInfo) {
      return;
    }

    const rtspProxy = this.proxySessions.get(sessionID);

    // No valid video source — can't start stream
    if (!rtspProxy?.proxyServer && !rtspProxy?.path) {
      this.log.warn(
        `${this.blinkCamera.name} - No video source available, cannot start stream`
      );
      this.pendingSessions.delete(sessionID);
      this.controller?.forceStopStreamingSession(sessionID);
      return;
    }

    const payloadType = video.pt;
    const maxBitrate = video.max_bit_rate;
    const address = sessionInfo.address;
    const videoPort = sessionInfo.videoPort;
    const videoSRTP = sessionInfo.videoSRTP.toString('base64');

    this.log.info(
      `${this.blinkCamera.name} - LiveView START (${video.width}x${video.height}, ${video.fps} fps, ${maxBitrate} kbps)`
    );

    const ffmpegArgs: string[] = [];

    if (rtspProxy?.isImmi && rtspProxy.proxyServer) {
      // IMMI protocol — MPEG-TS input from local tunnel
      ffmpegArgs.push(
        '-hide_banner',
        '-loglevel',
        'warning',
        '-analyzeduration',
        '0',
        '-probesize',
        '32768',
        '-fflags',
        '+nobuffer',
        '-flags',
        'low_delay',
        '-f',
        'mpegts',
        '-i',
        `tcp://localhost:${rtspProxy.listenPort}`,
        '-map',
        '0:v',
        '-vcodec',
        'copy',
        '-an',
        '-sn',
        '-dn'
      );
    } else if (rtspProxy?.proxyServer) {
      // RTSP protocol — copy codec
      ffmpegArgs.push(
        '-hide_banner',
        '-loglevel',
        'warning',
        '-i',
        `rtsp://localhost:${rtspProxy.listenPort}${rtspProxy.path}`,
        '-map',
        '0:0',
        '-vcodec',
        'copy',
        '-user-agent',
        'Immedia WalnutPlayer'
      );
    } else {
      ffmpegArgs.push(
        '-hide_banner',
        '-loglevel',
        'warning',
        '-loop',
        '1',
        '-framerate',
        '1',
        '-re',
        '-f',
        'image2',
        '-i',
        rtspProxy?.path ?? '',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'baseline',
        '-s',
        `${video.width}x${video.height}`,
        '-g',
        '300',
        '-r',
        '10',
        '-an',
        '-sn',
        '-dn',
        '-b:v',
        `${maxBitrate}k`,
        '-bufsize',
        `${2 * maxBitrate}k`,
        '-maxrate',
        `${maxBitrate}k`
      );
    }

    ffmpegArgs.push('-payload_type', String(payloadType), '-f', 'rtp');

    let targetProtocol = 'rtp';
    if (
      sessionInfo.videoCryptoSuite ===
      this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80
    ) {
      ffmpegArgs.push(
        '-ssrc',
        String(sessionInfo.videoSSRC),
        '-srtp_out_suite',
        'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params',
        videoSRTP
      );
      targetProtocol = 'srtp';
    }

    ffmpegArgs.push(
      `${targetProtocol}://${address}:${videoPort}?rtcpport=${videoPort}&localrtcpport=${videoPort}&pkt_size=${video.mtu}`
    );

    this.log.debug(`${this.blinkCamera.name} - ffmpeg ${ffmpegArgs.join(' ')}`);

    const ffmpegVideo = spawn(pathToFfmpeg || 'ffmpeg', ffmpegArgs, {
      env: process.env,
    });
    this.ongoingSessions.set(sessionID, ffmpegVideo);
    this.pendingSessions.delete(sessionID);

    // Auto-kill stream after 5 minutes to prevent orphaned processes
    const MAX_STREAM_MS = 5 * 60 * 1000;
    this.streamTimeouts.set(
      sessionID,
      setTimeout(() => {
        this.log.warn(
          `${this.blinkCamera.name} - Stream timeout (${MAX_STREAM_MS / 1000}s), stopping`
        );
        ffmpegVideo.kill('SIGKILL');
        this.controller?.forceStopStreamingSession(sessionID);
      }, MAX_STREAM_MS)
    );

    ffmpegVideo.stderr?.on('data', (data: Buffer) =>
      this.log.debug(`${this.blinkCamera.name} - STDERR: ${String(data)}`)
    );

    ffmpegVideo.on('error', error => {
      this.log.error(
        `${this.blinkCamera.name} - Failed to start ffmpeg: ${error.message}`
      );
    });

    ffmpegVideo.on('exit', (code, signal) => {
      const timeout = this.streamTimeouts.get(sessionID);
      if (timeout) {
        clearTimeout(timeout);
        this.streamTimeouts.delete(sessionID);
      }
      this.log.debug(`${this.blinkCamera.name} - ffmpeg ${signal}`);
      if (code !== null && code !== 255) {
        this.log.error(
          `${this.blinkCamera.name} - LiveView ERROR: ${signal} with code: ${code}`
        );
        this.controller?.forceStopStreamingSession(sessionID);
      }
    });
  }

  private async stopStream(sessionID: string): Promise<void> {
    this.log.info(`${this.blinkCamera.name} - LiveView STOP`);

    const timeout = this.streamTimeouts.get(sessionID);
    if (timeout) {
      clearTimeout(timeout);
      this.streamTimeouts.delete(sessionID);
    }

    // Check if this was a real live view before cleanup deletes the session
    const hadLiveView = this.proxySessions.get(sessionID)?.proxyServer != null;

    // Clean up temp snapshot file if it exists
    const tmpPath = join(tmpdir(), `blink-snapshot-${sessionID}.jpg`);
    unlink(tmpPath).catch(() => {});

    if (this.proxySessions.has(sessionID)) {
      try {
        const rtspProxy = this.proxySessions.get(sessionID);
        await rtspProxy?.proxyServer?.stop();
      } catch (e) {
        this.log.error(`${this.blinkCamera.name} - ERROR:`, e);
      }
      this.proxySessions.delete(sessionID);
    }

    if (this.ongoingSessions.has(sessionID)) {
      try {
        const ffmpegProcess = this.ongoingSessions.get(sessionID);
        ffmpegProcess?.kill('SIGKILL');
      } catch (e) {
        this.log.error(
          `${this.blinkCamera.name} - Error terminating video process:`,
          e
        );
      }
      this.ongoingSessions.delete(sessionID);
    }

    // After a real live view, request a fresh thumbnail so the Home app
    // shows a recent image instead of a stale one.
    // Skip for: image-fallback streams, battery cameras on disarmed networks,
    // and if a forced refresh already happened recently (avoid 409s).
    const shouldRefresh =
      hadLiveView &&
      (!this.blinkCamera.isBatteryPower || this.blinkCamera.armed) &&
      Date.now() - this.lastForcedRefresh > 300_000;

    if (shouldRefresh) {
      this.lastForcedRefresh = Date.now();
      this.blinkCamera
        .refreshThumbnail(true)
        .then(() => this.blinkCamera.clearThumbnailCache())
        .catch(e =>
          this.log.debug(
            `${this.blinkCamera.name} - Post-stream thumbnail refresh failed: ${e}`
          )
        );
    }
  }

  private async createTLSTunnel(
    listenPort: number,
    targetHost: string,
    protocol: string
  ): Promise<Http2TLSTunnel> {
    const proxyServer = new Http2TLSTunnel(
      listenPort,
      targetHost,
      '0.0.0.0',
      443,
      protocol
    );
    await proxyServer.start();
    return proxyServer;
  }

  private async createImmiTunnel(
    listenPort: number,
    targetHost: string,
    clientId: number,
    connectionId: string,
    serial: string
  ): Promise<ImmiTunnel> {
    const proxyServer = new ImmiTunnel(
      listenPort,
      targetHost,
      '0.0.0.0',
      443,
      clientId,
      connectionId,
      serial,
      this.log
    );
    await proxyServer.start();
    return proxyServer;
  }
}
