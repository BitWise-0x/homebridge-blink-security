import { BlockList, isIPv4 } from 'net';
import type { NetworkInterfaceInfo } from 'os';

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[] | undefined>;

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

const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet('169.254.0.0', 16, 'ipv4');

export function selectStreamAddress(
  targetAddress: string,
  interfaces: Interfaces,
  configured?: string,
  defaultAddress?: string
): StreamAddressSelection | undefined {
  const pinned = configured?.trim();
  if (pinned && addressIsLocal(pinned, interfaces)) {
    return { address: pinned, reason: 'configured' };
  }

  const subnet = addressOnTargetSubnet(
    targetAddress,
    interfaces,
    defaultAddress
  );
  if (subnet) {
    return { address: subnet, reason: 'subnet' };
  }

  if (defaultAddress) {
    return { address: defaultAddress, reason: 'default' };
  }
  return undefined;
}

export function addressIsLocal(
  address: string,
  interfaces: Interfaces
): boolean {
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (!info.internal && info.address === address) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Local IPv4 address on the same subnet as `targetAddress`. When several
 * interfaces match, `defaultAddress` wins if it is one of them; otherwise the
 * longest prefix wins. Skips loopback and link-local. Returns undefined when
 * nothing contains the target.
 */
export function addressOnTargetSubnet(
  targetAddress: string,
  interfaces: Interfaces,
  defaultAddress?: string
): string | undefined {
  if (!isRoutableIPv4(targetAddress)) {
    return undefined;
  }

  const matches: { address: string; prefix: number }[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (
        info.internal ||
        info.family !== 'IPv4' ||
        !isRoutableIPv4(info.address)
      ) {
        continue;
      }
      const prefix = prefixFromCidr(info.cidr);
      if (prefix === undefined || prefix === 0) {
        continue;
      }
      const subnet = new BlockList();
      subnet.addSubnet(info.address, prefix, 'ipv4');
      if (subnet.check(targetAddress, 'ipv4')) {
        matches.push({ address: info.address, prefix });
      }
    }
  }

  if (defaultAddress && matches.some(m => m.address === defaultAddress)) {
    return defaultAddress;
  }
  matches.sort((a, b) => b.prefix - a.prefix);
  return matches[0]?.address;
}

/**
 * Local address ffmpeg should bind its RTP output to, or undefined to let the
 * OS choose. Only set when the picked IPv4 differs from the default route, so
 * single-NIC hosts and IPv6 sessions behave exactly as before.
 */
export function rtpLocalAddress(
  sourceAddress: string | undefined,
  defaultAddress: string | undefined
): string | undefined {
  if (
    !sourceAddress ||
    sourceAddress === defaultAddress ||
    !isRoutableIPv4(sourceAddress)
  ) {
    return undefined;
  }
  return sourceAddress;
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

function isRoutableIPv4(address: string): boolean {
  return isIPv4(address) && !LINK_LOCAL.check(address, 'ipv4');
}

function prefixFromCidr(cidr: string | null): number | undefined {
  const prefix = Number(cidr?.split('/')[1]);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32
    ? prefix
    : undefined;
}
