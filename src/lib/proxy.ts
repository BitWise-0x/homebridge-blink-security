import net from 'net';
import tls from 'tls';
import { Transform, TransformCallback } from 'stream';
import type { Logger } from 'homebridge';

// ---------------------------------------------------------------------------
// RTSP-to-MPEGTS proxy: handles RTSP negotiation itself and feeds raw
// MPEG-TS to ffmpeg, bypassing ffmpeg's RTSP demuxer entirely.
//
// Blink XT servers auto-play after SETUP, sending interleaved RTP immediately.
// ffmpeg's RTSP state machine discards all RTP data received before it
// transitions to RTSP_STATE_STREAMING (after PLAY), losing the initial
// keyframe. By handling RTSP ourselves and stripping RTP headers, we
// capture every frame from the start.
//
// The SDP reveals the stream is MPEG-TS over RTP (payload type 33,
// a=rtpmap:33 MP2T/90000), not raw H.264. So we just strip RTP headers
// and feed the MPEG-TS payload directly to ffmpeg.
// ---------------------------------------------------------------------------

/**
 * Extract the video track control URL from SDP for use in SETUP request.
 */
function extractTrackUrl(sdp: string, baseUri: string): string {
  // Find the video media section, then look for a=control within it
  const videoSection = sdp.match(/m=video[\s\S]*?(?=m=|$)/);
  if (videoSection) {
    const controlMatch = videoSection[0].match(/a=control:(.+)/);
    if (controlMatch) {
      const control = controlMatch[1].trim();
      if (control.startsWith('rtsp://')) return control;
      // Relative control — append to base URI
      return `${baseUri.replace(/\/$/, '')}/${control}`;
    }
  }
  return baseUri;
}

/**
 * RTSP-to-MPEGTS proxy for Blink XT cameras.
 *
 * Handles RTSP negotiation (OPTIONS, DESCRIBE, SETUP) over TLS, then
 * de-frames interleaved RTP and strips RTP headers to emit raw MPEG-TS
 * served over local TCP for ffmpeg to consume with `-f mpegts`.
 */
export class RtspToH264Proxy {
  private readonly _listenHost: string;
  private readonly _listenPort: number;
  private readonly _targetHost: string;
  private readonly _tlsPort: number;
  private readonly _path: string;
  private readonly _log?: Logger;
  private _server?: net.Server;
  private _tcpSocket?: net.Socket;
  private _tlsSocket?: tls.TLSSocket;

  constructor(
    listenPort: number,
    targetHost: string,
    path: string,
    listenHost = '0.0.0.0',
    tlsPort = 443,
    log?: Logger
  ) {
    this._listenHost = listenHost;
    this._listenPort = listenPort;
    this._targetHost = targetHost;
    this._tlsPort = tlsPort;
    this._path = path;
    this._log = log;
  }

  get listenPort(): number {
    return this._listenPort;
  }

  async start(): Promise<net.Server | undefined> {
    if (this._server?.listening) {
      return this._server;
    }

    // Step 1: TLS connect
    const tlsSocket = await this._connectTls();
    this._tlsSocket = tlsSocket;
    this._log?.debug(
      `RTSP TLS connected to ${this._targetHost}:${this._tlsPort}`
    );

    // Shared accumulation buffer + notify callback for the entire connection.
    // A single persistent 'data' handler appends to this buffer. During
    // negotiation, _waitForResponse drains RTSP responses from it. After
    // negotiation, _consumeRtpFrames drains RTP frames from it.
    let buf: Buffer = Buffer.alloc(0);
    let onData: (() => void) | undefined;

    tlsSocket.on('data', (chunk: Buffer) => {
      buf = buf.length
        ? Buffer.from(Buffer.concat([buf, chunk]))
        : Buffer.from(chunk);
      if (onData) onData();
    });

    // Helper: wait for a complete RTSP response in `buf`, return the body
    // and leave leftover bytes in `buf`.
    const waitForResponse = (method: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        let headerEnd = -1;
        let contentLength = 0;
        let headersDone = false;

        const timer = setTimeout(() => {
          onData = undefined;
          reject(new Error(`RTSP ${method} timeout`));
        }, 10000);

        const tryParse = () => {
          // Skip any interleaved RTP frames ($) before the RTSP text response
          while (buf.length > 0 && buf[0] === 0x24) {
            if (buf.length < 4) return;
            const frameLen = 4 + buf.readUInt16BE(2);
            if (buf.length < frameLen) return;
            buf = Buffer.from(buf.subarray(frameLen));
          }
          if (buf.length === 0) return;

          if (!headersDone) {
            headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            headersDone = true;
            const headerStr = buf.subarray(0, headerEnd).toString('ascii');
            const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
            contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
          }

          const bodyStart = headerEnd + 4;
          if (buf.length - bodyStart < contentLength) return;

          // Full response received
          clearTimeout(timer);
          onData = undefined;
          const responseEnd = bodyStart + contentLength;
          const responseStr = buf.subarray(0, responseEnd).toString('ascii');
          buf =
            buf.length > responseEnd
              ? Buffer.from(buf.subarray(responseEnd))
              : Buffer.alloc(0);

          const bodyIdx = responseStr.indexOf('\r\n\r\n');
          const body = bodyIdx >= 0 ? responseStr.substring(bodyIdx + 4) : '';
          this._log?.debug(
            `RTSP ${method} response: ${responseStr.split('\r\n')[0]}`
          );
          if (body) {
            this._log?.debug(`RTSP ${method} body:\n${body}`);
          }
          resolve(body);
        };

        onData = tryParse;
        // Check if data is already in the buffer
        tryParse();
      });
    };

    // Helper: send an RTSP request
    const sendRequest = (
      method: string,
      uri: string,
      cseq: number,
      extraHeaders?: Record<string, string>
    ) => {
      let req = `${method} ${uri} RTSP/1.0\r\n`;
      req += `CSeq: ${cseq}\r\n`;
      req += 'User-Agent: Immedia WalnutPlayer\r\n';
      if (extraHeaders) {
        for (const [key, value] of Object.entries(extraHeaders)) {
          req += `${key}: ${value}\r\n`;
        }
      }
      req += '\r\n';
      tlsSocket.write(req);
    };

    // Step 2: RTSP negotiation
    const uri = `rtsp://${this._targetHost}${this._path}`;

    // OPTIONS (non-fatal)
    try {
      sendRequest('OPTIONS', uri, 1);
      await waitForResponse('OPTIONS');
    } catch (err) {
      this._log?.debug(
        `RTSP OPTIONS failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // DESCRIBE — get SDP
    sendRequest('DESCRIBE', uri, 2, { Accept: 'application/sdp' });
    const sdpBody = await waitForResponse('DESCRIBE');
    this._log?.debug(`RTSP SDP:\n${sdpBody}`);

    // Extract track URL from SDP for SETUP
    const trackUrl = extractTrackUrl(sdpBody, uri);
    this._log?.debug(`RTSP SETUP track: ${trackUrl}`);

    // SETUP — request interleaved TCP transport
    sendRequest('SETUP', trackUrl, 3, {
      Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1',
    });
    await waitForResponse('SETUP');

    // PLAY — required to start streaming; not all Blink servers auto-play
    sendRequest('PLAY', uri, 4, { Range: 'npt=0.000-' });
    await waitForResponse('PLAY');

    // Step 3: Switch to streaming mode
    let rtpFrameCount = 0;
    let tcpClient: net.Socket | undefined;

    this._log?.debug(`RTSP negotiation complete, ${buf.length} bytes buffered`);

    // Now the persistent data handler switches to RTP consumption
    onData = () => {
      const result = this._consumeRtpFrames(buf, rtpFrameCount, tcpClient);
      buf = result.remaining;
      rtpFrameCount = result.frameCount;
    };

    // Process any data already in the buffer from SETUP leftover
    if (buf.length > 0) {
      onData();
    }

    // Step 4: Start TCP server for ffmpeg
    this._server = net.createServer(socket => {
      this._tcpSocket = socket;
      tcpClient = socket;
      this._log?.debug(
        `RTSP MPEGTS ffmpeg client connected on port ${this._listenPort}`
      );

      // Flush any data accumulated before ffmpeg connected
      if (buf.length > 0) {
        const result = this._consumeRtpFrames(buf, rtpFrameCount, tcpClient);
        buf = result.remaining;
        rtpFrameCount = result.frameCount;
      }

      socket.on('error', () => {
        try {
          tlsSocket.end();
        } catch {
          // ignore
        }
      });
    });

    tlsSocket.on('error', err => {
      this._log?.debug(`RTSP TLS error: ${err.message}`);
      try {
        this._tcpSocket?.end();
      } catch {
        // ignore
      }
    });

    tlsSocket.on('close', () => {
      this._log?.debug('RTSP TLS closed');
      try {
        this._tcpSocket?.end();
      } catch {
        // ignore
      }
    });

    return new Promise(resolve => {
      this._server!.listen(this._listenPort, this._listenHost, () => {
        this._log?.debug(
          `RTSP MPEGTS proxy listening on port ${this._listenPort}`
        );
        resolve(this._server);
      });
    });
  }

  /**
   * Consume interleaved RTP frames from buffer, strip RTP headers,
   * and write MPEG-TS payload to the TCP client.
   */
  private _consumeRtpFrames(
    buf: Buffer,
    frameCount: number,
    client?: net.Socket
  ): { remaining: Buffer; frameCount: number } {
    while (buf.length > 0) {
      if (buf[0] === 0x24) {
        // Interleaved frame: $ + channel + length(2 BE) + payload
        if (buf.length < 4) break;
        const payloadLen = buf.readUInt16BE(2);
        const frameLen = 4 + payloadLen;
        if (buf.length < frameLen) break;

        const channel = buf[1];
        if (channel === 0 && payloadLen > 12) {
          // Video RTP — strip RTP header and write MPEG-TS payload
          const rtp = buf.subarray(4, frameLen);
          const headerLen = this._rtpHeaderLen(rtp);
          let end = rtp.length;

          // Handle RTP padding
          if ((rtp[0] & 0x20) !== 0 && end > headerLen) {
            const paddingLen = rtp[end - 1];
            if (paddingLen > 0 && paddingLen <= end - headerLen) {
              end -= paddingLen;
            }
          }

          if (headerLen < end) {
            const payload = rtp.subarray(headerLen, end);
            if (client && !client.destroyed) {
              client.write(payload);
            }
          }
          frameCount++;
        }
        buf = buf.subarray(frameLen);
      } else {
        // Non-interleaved data — skip to next $ marker
        const nextDollar = buf.indexOf(0x24, 1);
        if (nextDollar > 0) {
          buf = buf.subarray(nextDollar);
        } else {
          // No $ found — keep buffer, might be partial
          break;
        }
      }
    }

    return { remaining: buf, frameCount };
  }

  private _rtpHeaderLen(pkt: Buffer): number {
    if (pkt.length < 12) return pkt.length;
    const cc = pkt[0] & 0x0f;
    let offset = 12 + cc * 4;
    if (pkt[0] & 0x10) {
      if (pkt.length < offset + 4) return pkt.length;
      const extLen = pkt.readUInt16BE(offset + 2);
      offset += 4 + extLen * 4;
    }
    return offset;
  }

  private _connectTls(): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const tlsSocket = tls.connect({
        host: this._targetHost,
        port: this._tlsPort,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });

      const onError = (err: Error) => {
        tlsSocket.removeListener('secureConnect', onConnect);
        reject(err);
      };

      const onConnect = () => {
        tlsSocket.removeListener('error', onError);
        resolve(tlsSocket);
      };

      tlsSocket.once('secureConnect', onConnect);
      tlsSocket.once('error', onError);
    });
  }

  async stop(): Promise<void> {
    if (this._tcpSocket) {
      try {
        this._tcpSocket.end();
      } catch {
        // ignore
      }
    }
    if (this._tlsSocket) {
      try {
        this._tlsSocket.end();
      } catch {
        // ignore
      }
    }
    if (this._server?.listening) {
      try {
        this._server.close();
      } catch {
        // ignore
      }
    }
  }
}

// IMMI frame header: 9 bytes
// Byte 0: message type (0x00=VIDEO, 0x0A=KEEPALIVE, 0x12=LATENCY_STATS)
// Bytes 1-4: sequence number (uint32 BE)
// Bytes 5-8: payload length (uint32 BE)
const IMMI_HEADER_SIZE = 9;
const IMMI_MSG_VIDEO = 0x00;
// MPEG-TS sync byte (0x47) — retained for reference but no longer used
// for frame filtering since IMMI/MPEG-TS boundaries don't always align.

class ImmiFrameStripper extends Transform {
  private _buffer: Buffer = Buffer.alloc(0);
  private _payloadRemaining = 0;
  private _currentMsgType = -1;
  private _seenMsgTypes = new Map<
    number,
    { count: number; totalBytes: number }
  >();
  private _log?: Logger;
  private _firstVideoLogged = false;

  constructor(log?: Logger) {
    super();
    this._log = log;
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    done: TransformCallback
  ): void {
    this._buffer = this._buffer.length
      ? (Buffer.concat([this._buffer, chunk]) as Buffer)
      : chunk;

    while (this._buffer.length > 0) {
      if (this._payloadRemaining > 0) {
        const toConsume = Math.min(this._payloadRemaining, this._buffer.length);
        // Only forward VIDEO frames that contain MPEG-TS data
        if (this._currentMsgType === IMMI_MSG_VIDEO) {
          if (!this._firstVideoLogged) {
            this._firstVideoLogged = true;
            this._log?.info(`IMMI first video frame: ${toConsume} bytes`);
          }
          this.push(this._buffer.subarray(0, toConsume));
        }
        this._buffer = this._buffer.subarray(toConsume);
        this._payloadRemaining -= toConsume;
        continue;
      }

      // Need at least a full header
      if (this._buffer.length < IMMI_HEADER_SIZE) {
        break;
      }

      // Parse header
      this._currentMsgType = this._buffer[0];
      const seq = this._buffer.readUInt32BE(1);
      this._payloadRemaining = this._buffer.readUInt32BE(5);
      this._buffer = this._buffer.subarray(IMMI_HEADER_SIZE);

      // Track frame types for diagnostics
      const stats = this._seenMsgTypes.get(this._currentMsgType);
      if (stats) {
        stats.count++;
        stats.totalBytes += this._payloadRemaining;
      } else {
        this._seenMsgTypes.set(this._currentMsgType, {
          count: 1,
          totalBytes: this._payloadRemaining,
        });
        // Log first occurrence of each unknown frame type
        if (
          this._currentMsgType !== IMMI_MSG_VIDEO &&
          this._currentMsgType !== 0x0a &&
          this._currentMsgType !== 0x12
        ) {
          const preview =
            this._payloadRemaining > 0 && this._buffer.length > 0
              ? ` preview=${this._buffer.subarray(0, Math.min(16, this._payloadRemaining, this._buffer.length)).toString('hex')}`
              : '';
          this._log?.debug(
            `IMMI frame type=0x${this._currentMsgType.toString(16).padStart(2, '0')} seq=${seq} len=${this._payloadRemaining}${preview}`
          );
        }
      }

      // Forward all VIDEO frames — the MPEG-TS stream contains both
      // video and audio PIDs. Previously we checked for 0x47 sync byte
      // but that rejected frames where the IMMI/MPEG-TS boundaries
      // didn't align, dropping PAT/PMT tables needed for audio detection.
    }

    done();
  }

  /** Return summary of all frame types seen during this session. */
  getFrameStats(): Map<number, { count: number; totalBytes: number }> {
    return this._seenMsgTypes;
  }

  override _flush(done: TransformCallback): void {
    if (this._buffer.length > 0 && this._currentMsgType === IMMI_MSG_VIDEO) {
      this.push(this._buffer);
    }
    done();
  }
}

// IMMI latency stats: 33-byte packet (type 0x12) sent every ~1 second
const IMMI_LATENCY_STATS = Buffer.from([
  0x12, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
]);

// IMMI keep-alive: 9-byte minimal packet (type 0x0A) sent every ~10 seconds
const IMMI_KEEPALIVE = Buffer.alloc(9);
IMMI_KEEPALIVE[0] = 0x0a; // KEEPALIVE message type

/**
 * Build the IMMI binary connection header (122 bytes, TLV format).
 *
 * Layout:
 *   [0-3]     Magic 0x00000028
 *   [4-7]     Serial length (16)
 *   [8-23]    Serial field (zeros — we don't have the sync module serial)
 *   [24-27]   Client ID (camera ID, uint32 BE)
 *   [28]      0x01
 *   [29]      0x08
 *   [30-33]   Token length (64)
 *   [34-97]   Token field (zeros — auth token not required for IMMI)
 *   [98-101]  Connection ID length (16)
 *   [102-117] Connection ID (UTF-8, zero-padded to 16 bytes)
 *   [118-121] Trailer 0x00000001
 */
function buildImmiConnectionHeader(
  clientId: number,
  connectionId: string,
  serial: string
): Buffer {
  const buf = Buffer.alloc(122); // fixed size, zero-filled

  // Magic number (offset 0)
  buf.writeUInt32BE(0x00000028, 0);

  // Serial length prefix (offset 4) — 16
  buf.writeUInt32BE(16, 4);

  // Serial field (offset 8, 16 bytes, zero-padded UTF-8)
  if (serial) {
    buf.write(serial.substring(0, 16), 8, 'utf-8');
  }

  // Client ID (offset 24)
  buf.writeUInt32BE(clientId, 24);

  // Static bytes (offset 28-29)
  buf[28] = 0x01;
  buf[29] = 0x08;

  // Token length prefix (offset 30) — 64, field at [34-97] stays zeros
  buf.writeUInt32BE(64, 30);

  // Connection ID length prefix (offset 98) — 16
  buf.writeUInt32BE(16, 98);

  // Connection ID (offset 102, 16 bytes, zero-padded)
  buf.write(connectionId.substring(0, 16), 102, 'utf-8');

  // Trailer (offset 118)
  buf.writeUInt32BE(0x00000001, 118);

  return buf;
}

export class ImmiTunnel {
  private readonly _listenHost: string;
  private readonly _listenPort: number;
  private readonly _targetHost: string;
  private readonly _tlsPort: number;
  private readonly _clientId: number;
  private readonly _connectionId: string;
  private readonly _serial: string;
  private readonly _log?: Logger;
  private _server?: net.Server;
  private _tlsSocket?: tls.TLSSocket;
  private _tcpSocket?: net.Socket;
  private _latencyInterval?: ReturnType<typeof setInterval>;
  private _keepAliveInterval?: ReturnType<typeof setInterval>;
  private _stripper?: ImmiFrameStripper;

  constructor(
    listenPort: number,
    targetHost: string,
    listenHost = '0.0.0.0',
    tlsPort = 443,
    clientId = 0,
    connectionId = '',
    serial = '',
    log?: Logger
  ) {
    this._listenHost = listenHost;
    this._listenPort = listenPort;
    this._targetHost = targetHost;
    this._tlsPort = tlsPort;
    this._clientId = clientId;
    this._connectionId = connectionId;
    this._serial = serial;
    this._log = log;
  }

  get listenPort(): number {
    return this._listenPort;
  }

  /** Exposed for stdin piping — returns the stripped MPEG-TS stream. */
  get dataStream(): Transform | undefined {
    return this._stripper;
  }

  /**
   * Establish TLS to the IMMI server, send the handshake, then start
   * a local TCP server for ffmpeg to connect to.
   */
  async start(): Promise<net.Server | undefined> {
    if (this._server?.listening) {
      return this._server;
    }

    // Step 1: Connect TLS to the Blink IMMI server and send handshake
    const tlsSocket = await this._connectTls();
    this._tlsSocket = tlsSocket;
    this._log?.debug(
      `IMMI TLS connected to ${this._targetHost}:${this._tlsPort}`
    );

    // Step 2: Send the binary connection header
    const connHeader = buildImmiConnectionHeader(
      this._clientId,
      this._connectionId,
      this._serial
    );
    tlsSocket.write(connHeader);
    this._log?.info(
      `IMMI auth sent: clientId=${this._clientId}, connId=${this._connectionId}, serial=${this._serial} (${connHeader.length} bytes)`
    );

    // Step 3: Start latency stats every 1s and keep-alive every 10s
    this._latencyInterval = setInterval(() => {
      if (!tlsSocket.destroyed) {
        tlsSocket.write(IMMI_LATENCY_STATS);
      }
    }, 1000);
    this._keepAliveInterval = setInterval(() => {
      if (!tlsSocket.destroyed) {
        tlsSocket.write(IMMI_KEEPALIVE);
      }
    }, 10000);

    // Step 4: Pipe TLS data through frame stripper to extract clean MPEG-TS.
    // The IMMI VIDEO frames (type 0x00) contain MPEG-TS with multiplexed
    // H.264 video and AAC audio. The stripper removes IMMI frame headers
    // and control frames, passing only the MPEG-TS payload to ffmpeg.
    this._stripper = new ImmiFrameStripper(this._log);
    let firstData = true;
    tlsSocket.on('data', (chunk: Buffer) => {
      if (firstData) {
        this._log?.info(
          `IMMI first data: ${chunk.length} bytes (first byte: 0x${chunk[0]?.toString(16).padStart(2, '0')})`
        );
        firstData = false;
      }
    });
    tlsSocket.pipe(this._stripper);

    // Step 5: Start TCP server for ffmpeg — pipe stripper output to ffmpeg.
    // Also used as fallback; primary path is stdin piping via dataStream getter.
    this._server = net.createServer(tcpSocket => {
      this._tcpSocket = tcpSocket;
      this._log?.debug(
        `IMMI ffmpeg client connected on port ${this._listenPort}`
      );
      this._stripper!.pipe(tcpSocket);

      tcpSocket.on('error', () => {
        this._stopKeepAlive();
        try {
          tlsSocket.end();
        } catch {
          // ignore
        }
      });
    });

    tlsSocket.on('error', err => {
      this._log?.error(`IMMI TLS error: ${err.message}`);
      this._stopKeepAlive();
      try {
        this._tcpSocket?.end();
      } catch {
        // ignore
      }
    });

    tlsSocket.on('close', () => {
      this._log?.debug('IMMI TLS closed');
      this._stopKeepAlive();
      try {
        this._tcpSocket?.end();
      } catch {
        // ignore
      }
    });

    return new Promise(resolve => {
      this._server!.listen(this._listenPort, this._listenHost, () => {
        resolve(this._server);
      });
    });
  }

  private _connectTls(): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const tlsSocket = tls.connect({
        host: this._targetHost,
        port: this._tlsPort,
        servername: this._targetHost,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });

      const onError = (err: Error) => {
        tlsSocket.removeListener('secureConnect', onConnect);
        reject(err);
      };

      const onConnect = () => {
        tlsSocket.removeListener('error', onError);
        resolve(tlsSocket);
      };

      tlsSocket.once('secureConnect', onConnect);
      tlsSocket.once('error', onError);
    });
  }

  private _stopKeepAlive(): void {
    if (this._latencyInterval) {
      clearInterval(this._latencyInterval);
      this._latencyInterval = undefined;
    }
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = undefined;
    }
  }

  async stop(): Promise<void> {
    this._stopKeepAlive();
    if (this._tcpSocket) {
      try {
        this._tcpSocket.end();
      } catch {
        // ignore
      }
    }
    if (this._tlsSocket) {
      try {
        this._tlsSocket.end();
      } catch {
        // ignore
      }
    }
    if (this._server?.listening) {
      try {
        this._server.close();
      } catch {
        // ignore
      }
    }
  }
}
