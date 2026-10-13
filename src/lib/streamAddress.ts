import type { NetworkInterfaceInfo } from 'os';

/**
 * Which local address HomeKit should treat as the camera, and which address
 * ffmpeg should send RTP from.
 *
 * `getDefaultIpAddress()` follows the host default route. On a multi-homed
 * host (a VM with a NAT NIC plus a bridged LAN NIC, Tailscale, docker bridges)
 * that route is often an address the Home app cannot reach. RTP then leaves
 * from the LAN NIC while HomeKit was told to talk to the unreachable one, and
 * the live view spins until HomeKit's no-data timeout.
 */
export interface StreamAddressSelection {
  address: string;
  /** Why this address was chosen. `default` is the single-NIC fallback. */
  reason: 'configured' | 'subnet' | 'default';
}

export function selectStreamAddress(
  targetAddress: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined>,
  configured?: string,
  fallback?: string
): StreamAddressSelection | undefined {
  const pinned = configured?.trim();
  if (pinned && addressIsLocal(pinned, interfaces)) {
    return { address: pinned, reason: 'configured' };
  }

  const subnet = addressOnTargetSubnet(targetAddress, interfaces);
  if (subnet) {
    return { address: subnet, reason: 'subnet' };
  }

  if (fallback) {
    return { address: fallback, reason: 'default' };
  }
  return undefined;
}

export function addressIsLocal(
  address: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined>
): boolean {
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal) {
        continue;
      }
      if (info.address === address) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Local address on the same subnet as `targetAddress`, longest prefix wins.
 * Skips loopback. Returns undefined when nothing contains the target.
 */
export function addressOnTargetSubnet(
  targetAddress: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined>
): string | undefined {
  const target = ipv4ToInt(targetAddress);
  if (target === undefined) {
    return undefined;
  }

  let best: { address: string; prefix: number } | undefined;
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4') {
        continue;
      }
      const ip = ipv4ToInt(info.address);
      const mask = ipv4ToInt(info.netmask);
      if (ip === undefined || mask === undefined || mask === 0) {
        continue;
      }
      if ((ip & mask) !== (target & mask)) {
        continue;
      }
      const prefix = prefixLength(mask);
      if (!best || prefix > best.prefix) {
        best = { address: info.address, prefix };
      }
    }
  }
  return best?.address;
}

/** ffmpeg RTP/SRTP output URL, sourced from `localAddress` when set. */
export function rtpOutputUrl(
  protocol: string,
  address: string,
  port: number,
  packetSize: number,
  localAddress?: string
): string {
  const host =
    address.includes(':') && !address.startsWith('[')
      ? `[${address}]`
      : address;
  const query = [`rtcpport=${port}`, `pkt_size=${packetSize}`];
  if (localAddress) {
    query.push(`localaddr=${localAddress}`);
  }
  return `${protocol}://${host}:${port}?${query.join('&')}`;
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function prefixLength(mask: number): number {
  let bits = 0;
  let m = mask;
  while (m) {
    bits += m & 1;
    m >>>= 1;
  }
  return bits;
}
