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
  type AudioInfo,
  type VideoInfo,
} from 'homebridge';

import { getDefaultIpAddress, reservePorts } from '@homebridge/camera-utils';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pathToFfmpeg: string = require('ffmpeg-for-homebridge');

import type { BlinkCamera } from '../devices/camera.js';
import { ImmiTunnel, RtspToH264Proxy } from '../lib/proxy.js';
import { sleep } from '../lib/utils.js';

interface SessionInfo {
  address: string;
  videoPort: number;
  videoCryptoSuite: number;
  videoSRTP: Buffer;
  videoSSRC: number;
  audioPort: number;
  audioCryptoSuite: number;
  audioSRTP: Buffer;
  audioSSRC: number;
}

interface ProxySession {
  path?: string;
  protocol?: string;
  host?: string;
  listenPort?: number;
  proxyServer?: ImmiTunnel | RtspToH264Proxy;
  isImmi?: boolean;
  isRtsp?: boolean;
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
  private streamStartTimes = new Map<string, number>();
  private streamRetries = new Map<string, number>();
  private sessionInfoCache = new Map<string, SessionInfo>();
  private outputErrorSessions = new Set<string>();
  private lastForcedRefresh = 0;

  private static readonly RETRYABLE_FFMPEG_CODES = new Set([251, 187]);
  private static readonly MAX_STREAM_RETRIES = 2;
  private static readonly RETRY_DELAY_MS = 2000;

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
      audioPort: request.audio.port,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([
        request.audio.srtp_key,
        request.audio.srtp_salt,
      ]),
      audioSSRC,
    };

    const audioResponse = request.audio
      ? {
          port: request.audio.port,
          ssrc: audioSSRC,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        }
      : undefined;

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
      audio: audioResponse,
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
      // RTSPS — proxy handles RTSP negotiation and serves MPEG-TS over local TCP
      const [, protocol, host, path] = urlRegex.exec(liveViewURL)!;
      const [listenPort] = await reservePorts({ count: 1 });
      const proxyServer = new RtspToH264Proxy(
        listenPort,
        host,
        path,
        '0.0.0.0',
        443,
        this.log
      );
      await proxyServer.start();
      this.proxySessions.set(request.sessionID, {
        protocol,
        host,
        path,
        listenPort,
        proxyServer,
        isRtsp: true,
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
      await this.startStream(request.sessionID, request.video, request.audio);
    } else if (request.type === StreamRequestTypes.RECONFIGURE) {
      const v = request.video;
      this.log.info(
        `${this.blinkCamera.name} - LiveView RECONFIGURE` +
          ` (${v.width}x${v.height}, ${v.fps} fps, ${v.max_bit_rate} kbps)`
      );
      // Acknowledge reconfigure — we can't change the Blink stream parameters
      // mid-stream, but acknowledging prevents HomeKit from killing the stream.
    } else if (request.type === StreamRequestTypes.STOP) {
      await this.stopStream(request.sessionID);
    }
    callback();
  }

  private async startStream(
    sessionID: string,
    video: VideoInfo,
    audio: AudioInfo
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

    // IMMI streams have audio; RTSP XT streams are video-only; static fallback has none.
    const hasAudio = !!rtspProxy?.proxyServer && !rtspProxy?.isRtsp;

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
        '+nobuffer+genpts+discardcorrupt',
        '-err_detect',
        'ignore_err',
        '-flags',
        'low_delay',
        '-f',
        'mpegts',
        '-i',
        `tcp://localhost:${rtspProxy.listenPort}?timeout=5000000`,
        '-map',
        '0:v',
        '-vcodec',
        'copy',
        '-sn',
        '-dn'
      );
    } else if (rtspProxy?.isRtsp && rtspProxy.proxyServer) {
      // RTSPS via RTSP-to-MPEGTS proxy — the proxy handles RTSP negotiation,
      // strips interleaved framing and RTP headers, serves raw MPEG-TS over TCP.
      // Re-encode with libx264 to smooth bursty frame delivery from Blink XT
      // and produce immediate keyframes (source has ~8s keyframe interval).
      // Use CRF for consistent quality instead of bitrate caps that starve the encoder.
      ffmpegArgs.push(
        '-hide_banner',
        '-loglevel',
        'warning',
        '-analyzeduration',
        '0',
        '-probesize',
        '131072',
        '-fflags',
        '+nobuffer+discardcorrupt',
        '-flags',
        'low_delay',
        '-f',
        'mpegts',
        '-i',
        `tcp://localhost:${rtspProxy.listenPort}`,
        '-fps_mode',
        'passthrough',
        '-map',
        '0:v',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'baseline',
        '-crf',
        '23',
        '-g',
        '30',
        '-sn',
        '-dn'
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
      `${targetProtocol}://${address}:${videoPort}?rtcpport=${videoPort}&pkt_size=${video.mtu}`
    );

    // Audio output — transcode AAC from camera to OPUS for HomeKit
    if (hasAudio) {
      const audioSRTP = sessionInfo.audioSRTP.toString('base64');
      const audioPort = sessionInfo.audioPort;

      ffmpegArgs.push(
        '-map',
        '0:a:0?',
        '-codec:a',
        'libopus',
        '-application',
        'lowdelay',
        '-flags',
        '+global_header',
        '-ar',
        `${audio.sample_rate}k`,
        '-b:a',
        `${audio.max_bit_rate}k`,
        '-ac',
        String(audio.channel),
        '-payload_type',
        String(audio.pt),
        '-f',
        'rtp'
      );

      let audioProtocol = 'rtp';
      if (
        sessionInfo.audioCryptoSuite ===
        this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80
      ) {
        ffmpegArgs.push(
          '-ssrc',
          String(sessionInfo.audioSSRC),
          '-srtp_out_suite',
          'AES_CM_128_HMAC_SHA1_80',
          '-srtp_out_params',
          audioSRTP
        );
        audioProtocol = 'srtp';
      }

      ffmpegArgs.push(
        `${audioProtocol}://${address}:${audioPort}?rtcpport=${audioPort}&pkt_size=188`
      );
    }

    this.log.debug(`${this.blinkCamera.name} - ffmpeg ${ffmpegArgs.join(' ')}`);

    const ffmpegVideo = spawn(pathToFfmpeg || 'ffmpeg', ffmpegArgs, {
      env: process.env,
    });
    this.ongoingSessions.set(sessionID, ffmpegVideo);
    this.streamStartTimes.set(sessionID, Date.now());
    this.sessionInfoCache.set(sessionID, sessionInfo);
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

    ffmpegVideo.stderr?.on('data', (data: Buffer) => {
      const msg = String(data).trim();
      this.log.debug(`${this.blinkCamera.name} - ffmpeg: ${msg}`);
      if (msg.includes('bind failed') || msg.includes('Error opening output')) {
        this.outputErrorSessions.add(sessionID);
      }
    });

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
        const retries = this.streamRetries.get(sessionID) ?? 0;
        const isOutputError = this.outputErrorSessions.has(sessionID);
        this.outputErrorSessions.delete(sessionID);
        const isRetryable =
          BlinkCameraDelegate.RETRYABLE_FFMPEG_CODES.has(code) &&
          retries < BlinkCameraDelegate.MAX_STREAM_RETRIES &&
          !isOutputError;

        if (isRetryable) {
          this.streamRetries.set(sessionID, retries + 1);
          this.log.warn(
            `${this.blinkCamera.name} - LiveView lost (code ${code}), retrying (${retries + 1}/${BlinkCameraDelegate.MAX_STREAM_RETRIES})...`
          );
          this.retryImmiStream(sessionID, video, audio).catch(err =>
            this.log.error(`${this.blinkCamera.name} - Retry failed: ${err}`)
          );
        } else {
          this.streamRetries.delete(sessionID);
          this.log.error(
            `${this.blinkCamera.name} - LiveView ERROR: ${signal} with code: ${code}`
          );
          this.controller?.forceStopStreamingSession(sessionID);
        }
      } else {
        this.streamRetries.delete(sessionID);
      }
    });
  }

  private async stopStream(sessionID: string): Promise<void> {
    this.streamRetries.delete(sessionID);
    this.sessionInfoCache.delete(sessionID);
    this.outputErrorSessions.delete(sessionID);
    const startTime = this.streamStartTimes.get(sessionID);
    const elapsed = startTime
      ? ((Date.now() - startTime) / 1000).toFixed(1)
      : '?';
    this.streamStartTimes.delete(sessionID);
    this.log.info(
      `${this.blinkCamera.name} - LiveView STOP (streamed ${elapsed}s)`
    );

    const timeout = this.streamTimeouts.get(sessionID);
    if (timeout) {
      clearTimeout(timeout);
      this.streamTimeouts.delete(sessionID);
    }

    // Check if this was a real live view before cleanup deletes the session
    const session = this.proxySessions.get(sessionID);
    const hadLiveView = session?.proxyServer !== undefined;

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
    // Skip for: image-fallback streams and if a forced refresh already
    // happened recently (avoid 409s).
    const shouldRefresh =
      hadLiveView && Date.now() - this.lastForcedRefresh > 300_000;

    if (shouldRefresh) {
      this.lastForcedRefresh = Date.now();
      this.blinkCamera
        .refreshThumbnail(true)
        .catch(e =>
          this.log.debug(
            `${this.blinkCamera.name} - Post-stream thumbnail refresh failed: ${e}`
          )
        )
        .finally(() => this.blinkCamera.clearThumbnailCache());
    }
  }

  private async retryImmiStream(
    sessionID: string,
    video: VideoInfo,
    audio: AudioInfo
  ): Promise<void> {
    // Clean up old proxy and ffmpeg process
    const oldProxy = this.proxySessions.get(sessionID);
    try {
      await oldProxy?.proxyServer?.stop();
    } catch {
      // ignore cleanup errors
    }
    const oldFfmpeg = this.ongoingSessions.get(sessionID);
    if (oldFfmpeg && !oldFfmpeg.killed) {
      oldFfmpeg.kill('SIGKILL');
    }
    this.ongoingSessions.delete(sessionID);

    await sleep(BlinkCameraDelegate.RETRY_DELAY_MS);

    // Request fresh LiveView URL
    let liveViewURL: string | undefined;
    try {
      liveViewURL = await this.blinkCamera.getLiveViewURL(30);
    } catch (err) {
      this.log.warn(
        `${this.blinkCamera.name} - Retry: LiveView request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!liveViewURL?.startsWith('immis')) {
      this.log.warn(
        `${this.blinkCamera.name} - Retry: no IMMI URL returned, giving up`
      );
      this.streamRetries.delete(sessionID);
      this.controller?.forceStopStreamingSession(sessionID);
      return;
    }

    // Parse the new IMMI URL and create a fresh tunnel
    const urlRegex = /([a-z]+):\/\/([^:/]+)(?::[0-9]+)?(\/.*)/;
    const match = urlRegex.exec(liveViewURL);
    if (!match) {
      this.streamRetries.delete(sessionID);
      this.controller?.forceStopStreamingSession(sessionID);
      return;
    }

    const [, protocol, host, path] = match;
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

    this.proxySessions.set(sessionID, {
      protocol,
      host,
      path,
      listenPort,
      proxyServer,
      isImmi: true,
    });

    this.log.info(`${this.blinkCamera.name} - LiveView: ${liveViewURL}`);

    // Restore sessionInfo from cache so startStream can access it
    const sessionInfo = this.sessionInfoCache.get(sessionID);
    if (!sessionInfo) {
      this.log.warn(
        `${this.blinkCamera.name} - Retry: session info missing, giving up`
      );
      this.streamRetries.delete(sessionID);
      this.controller?.forceStopStreamingSession(sessionID);
      return;
    }
    this.pendingSessions.set(sessionID, sessionInfo);

    await this.startStream(sessionID, video, audio);
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
