import net from 'net';
import tls from 'tls';
import { Transform, TransformCallback } from 'stream';
import type { Logger } from 'homebridge';

// Shared state between the CSeq tracker and fixer transforms
interface CSeqState {
  expectedCSeq: number;
}

/**
 * CSeqTracker: Observes RTSP requests from ffmpeg (client → server) and
 * records the CSeq value. Passes all data through unchanged.
 */
class CSeqTracker extends Transform {
  private _textBuf = '';
  private readonly _state: CSeqState;

  constructor(state: CSeqState) {
    super();
    this._state = state;
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    done: TransformCallback
  ): void {
    this.push(chunk);

    this._textBuf += chunk.toString('ascii');
    const match = this._textBuf.match(/CSeq:\s*(\d+)/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num)) {
        this._state.expectedCSeq = num;
      }
    }

    // Prevent unbounded memory growth — only need the tail
    if (this._textBuf.length > 512) {
      this._textBuf = this._textBuf.slice(-256);
    }

    done();
  }
}

/**
 * CSeqFixer: Rewrites the CSeq header in RTSP responses from the Blink
 * server to match the value ffmpeg expects. Correctly handles interleaved
 * RTP frames ($ prefix) by passing them through untouched.
 *
 * Blink XT cameras always respond with CSeq: 1 regardless of the request,
 * which causes ffmpeg to discard SETUP/PLAY responses and fail.
 */
class CSeqFixer extends Transform {
  private _buf: Buffer = Buffer.alloc(0);
  private _bodyRemaining = 0;
  private readonly _state: CSeqState;

  constructor(state: CSeqState) {
    super();
    this._state = state;
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    done: TransformCallback
  ): void {
    this._buf = this._buf.length
      ? (Buffer.concat([this._buf, chunk]) as Buffer)
      : chunk;

    while (this._buf.length > 0) {
      // Forward response body bytes (e.g. SDP after DESCRIBE)
      if (this._bodyRemaining > 0) {
        const toConsume = Math.min(this._bodyRemaining, this._buf.length);
        this.push(this._buf.subarray(0, toConsume));
        this._buf = this._buf.subarray(toConsume);
        this._bodyRemaining -= toConsume;
        continue;
      }

      const firstByte = this._buf[0];

      if (firstByte === 0x24) {
        // Interleaved RTP frame: $ (1) + channel (1) + length (2 BE) + payload
        if (this._buf.length < 4) break;
        const frameLen = 4 + this._buf.readUInt16BE(2);
        if (this._buf.length < frameLen) break;
        this.push(this._buf.subarray(0, frameLen));
        this._buf = this._buf.subarray(frameLen);
      } else {
        // RTSP text response — buffer until end of headers
        const headerEnd = this._buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const headerBlock = this._buf.subarray(0, headerEnd + 4);
        this._buf = this._buf.subarray(headerEnd + 4);

        // Rewrite CSeq to match what ffmpeg expects
        let headerStr = headerBlock.toString('ascii');
        if (this._state.expectedCSeq > 0) {
          headerStr = headerStr.replace(
            /^CSeq:\s*\d+/im,
            `CSeq: ${this._state.expectedCSeq}`
          );
        }

        this.push(Buffer.from(headerStr, 'ascii'));

        // Check for Content-Length body (e.g. SDP in DESCRIBE response)
        const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (clMatch) {
          this._bodyRemaining = parseInt(clMatch[1], 10);
        }
      }
    }

    done();
  }

  override _flush(done: TransformCallback): void {
    if (this._buf.length > 0) {
      this.push(this._buf);
    }
    done();
  }
}

/**
 * TLS-terminating proxy for RTSP streams with CSeq correction.
 *
 * ffmpeg connects to localhost:PORT over plain TCP. The proxy establishes
 * a TLS connection to the Blink RTSPS server and pipes data bidirectionally,
 * fixing the CSeq header in server responses so ffmpeg accepts them.
 */
export class RtspTlsProxy {
  private readonly _listenHost: string;
  private readonly _listenPort: number;
  private readonly _targetHost: string;
  private readonly _tlsPort: number;
  private readonly _log?: Logger;
  private _server?: net.Server;
  private _tcpSocket?: net.Socket;
  private _tlsSocket?: tls.TLSSocket;

  constructor(
    listenPort: number,
    targetHost: string,
    listenHost = '0.0.0.0',
    tlsPort = 443,
    log?: Logger
  ) {
    this._listenHost = listenHost;
    this._listenPort = listenPort;
    this._targetHost = targetHost;
    this._tlsPort = tlsPort;
    this._log = log;
  }

  get listenPort(): number {
    return this._listenPort;
  }

  async start(): Promise<net.Server | undefined> {
    if (this._server?.listening) {
      return this._server;
    }

    this._server = net.createServer(tcpSocket => {
      this._tcpSocket = tcpSocket;

      const tlsSocket = tls.connect({
        host: this._targetHost,
        port: this._tlsPort,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });

      tlsSocket.on('secureConnect', () => {
        this._tlsSocket = tlsSocket;

        const state: CSeqState = { expectedCSeq: 0 };
        const tracker = new CSeqTracker(state);
        const fixer = new CSeqFixer(state);

        // ffmpeg → CSeqTracker (observe CSeq) → Blink server
        tcpSocket.pipe(tracker).pipe(tlsSocket);
        // Blink server → CSeqFixer (rewrite CSeq) → ffmpeg
        tlsSocket.pipe(fixer).pipe(tcpSocket);
      });

      tlsSocket.on('error', err => {
        this._log?.debug(`RTSP TLS error: ${err.message}`);
        try {
          tcpSocket.end();
        } catch {
          // ignore
        }
      });

      tcpSocket.on('error', () => {
        try {
          tlsSocket.end();
        } catch {
          // ignore
        }
      });

      tlsSocket.on('close', () => {
        try {
          tcpSocket.end();
        } catch {
          // ignore
        }
      });
    });

    return new Promise(resolve => {
      this._server!.listen(this._listenPort, this._listenHost, () => {
        resolve(this._server);
      });
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
const IMMI_TS_SYNC = 0x47; // MPEG-TS sync byte

class ImmiFrameStripper extends Transform {
  private _buffer: Buffer = Buffer.alloc(0);
  private _payloadRemaining = 0;
  private _currentMsgType = -1;

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
      this._payloadRemaining = this._buffer.readUInt32BE(5);
      this._buffer = this._buffer.subarray(IMMI_HEADER_SIZE);

      // For video frames, peek at first byte to verify MPEG-TS sync
      if (
        this._currentMsgType === IMMI_MSG_VIDEO &&
        this._payloadRemaining > 0 &&
        this._buffer.length > 0 &&
        this._buffer[0] !== IMMI_TS_SYNC
      ) {
        // Not MPEG-TS — skip this frame
        this._currentMsgType = -1;
      }
    }

    done();
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

  /**
   * Establish TLS to the IMMI server, send the handshake, then start
   * a local TCP server for ffmpeg to connect to. By the time ffmpeg
   * connects, the TLS pipe should already have data buffered.
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

    // Step 4: Pipe TLS data through frame stripper (buffers until TCP client connects)
    this._stripper = new ImmiFrameStripper();
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

    // Step 5: Start TCP server for ffmpeg — pipe stripper output to ffmpeg
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
