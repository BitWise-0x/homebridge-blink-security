import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'os';
import {
  addressOnTargetSubnet,
  rtpLocalAddress,
  rtpOutputUrl,
  selectStreamAddress,
} from '../streamAddress.js';

function iface(
  address: string,
  netmask: string,
  extra: Partial<NetworkInterfaceInfo> = {}
): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/${maskBits(netmask)}`,
    ...extra,
  };
}

function maskBits(netmask: string): number {
  return netmask
    .split('.')
    .reduce(
      (n, octet) => n + Number(octet).toString(2).split('1').length - 1,
      0
    );
}

/** Colima-style host: NAT default NIC plus a bridged LAN NIC and docker bridges. */
const MULTIHOME = {
  lo: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
  eth0: [iface('192.168.5.1', '255.255.255.0')],
  col0: [iface('192.168.10.20', '255.255.255.0')],
  docker0: [iface('172.17.0.1', '255.255.0.0')],
  tailscale0: [iface('100.91.8.111', '255.255.255.255')],
};

describe('addressOnTargetSubnet', () => {
  it('picks the LAN NIC when the default route NIC is a different subnet', () => {
    expect(addressOnTargetSubnet('192.168.10.135', MULTIHOME)).toBe(
      '192.168.10.20'
    );
  });

  it('picks the NAT NIC when the controller is on that subnet', () => {
    expect(addressOnTargetSubnet('192.168.5.20', MULTIHOME)).toBe(
      '192.168.5.1'
    );
  });

  it('prefers the longest matching prefix', () => {
    const ifaces = {
      wide: [iface('10.1.0.1', '255.255.0.0')],
      narrow: [iface('10.1.8.5', '255.255.255.0')],
    };
    expect(addressOnTargetSubnet('10.1.8.40', ifaces)).toBe('10.1.8.5');
  });

  it('ignores loopback and a /32 that does not contain the target', () => {
    expect(addressOnTargetSubnet('100.92.1.4', MULTIHOME)).toBeUndefined();
    expect(addressOnTargetSubnet('127.0.0.2', MULTIHOME)).toBeUndefined();
  });

  it('prefers the default-route address when several NICs match', () => {
    const ifaces = {
      wlan0: [iface('10.0.1.30', '255.255.255.0')],
      eth0: [iface('10.0.1.15', '255.255.255.0')],
    };
    expect(addressOnTargetSubnet('10.0.1.50', ifaces, '10.0.1.15')).toBe(
      '10.0.1.15'
    );
    expect(
      selectStreamAddress('10.0.1.50', ifaces, undefined, '10.0.1.15')
    ).toEqual({ address: '10.0.1.15', reason: 'subnet' });
  });

  it('skips link-local interfaces and targets', () => {
    const ifaces = {
      en5: [iface('169.254.10.2', '255.255.0.0')],
      en0: [iface('192.168.10.5', '255.255.255.0')],
    };
    expect(addressOnTargetSubnet('169.254.10.9', ifaces)).toBeUndefined();
  });

  it('returns undefined for a non-IPv4 target', () => {
    expect(
      addressOnTargetSubnet('fe80::1', {
        en0: [iface('192.168.10.5', '255.255.255.0')],
      })
    ).toBeUndefined();
  });
});

describe('selectStreamAddress', () => {
  it('uses a configured address that exists on the host', () => {
    expect(
      selectStreamAddress(
        '192.168.10.135',
        MULTIHOME,
        '192.168.10.20',
        '192.168.5.1'
      )
    ).toEqual({ address: '192.168.10.20', reason: 'configured' });
  });

  it('ignores a configured address that is not on any interface', () => {
    expect(
      selectStreamAddress(
        '192.168.10.135',
        MULTIHOME,
        '10.9.9.9',
        '192.168.5.1'
      )
    ).toEqual({ address: '192.168.10.20', reason: 'subnet' });
  });

  it('falls back to the default-route address when no subnet matches', () => {
    expect(
      selectStreamAddress('10.9.9.9', MULTIHOME, undefined, '192.168.5.1')
    ).toEqual({ address: '192.168.5.1', reason: 'default' });
  });

  it('returns undefined when nothing matches and no fallback is given', () => {
    expect(selectStreamAddress('10.9.9.9', MULTIHOME)).toBeUndefined();
  });
});

describe('rtpLocalAddress', () => {
  it('binds only when the picked address differs from the default route', () => {
    expect(rtpLocalAddress('192.168.10.20', '192.168.5.1')).toBe(
      '192.168.10.20'
    );
    expect(rtpLocalAddress('192.168.5.1', '192.168.5.1')).toBeUndefined();
    expect(rtpLocalAddress(undefined, '192.168.5.1')).toBeUndefined();
  });

  it('never binds IPv6 or link-local addresses', () => {
    expect(rtpLocalAddress('fe80::2', 'fe80::1')).toBeUndefined();
    expect(rtpLocalAddress('169.254.3.4', '192.168.5.1')).toBeUndefined();
  });
});

describe('rtpOutputUrl', () => {
  it('adds localaddr so RTP is sourced from the selected NIC', () => {
    expect(
      rtpOutputUrl('srtp', '192.168.10.135', 50123, 1328, '192.168.10.20')
    ).toBe(
      'srtp://192.168.10.135:50123?rtcpport=50123&pkt_size=1328&localaddr=192.168.10.20'
    );
  });

  it('omits localaddr when no source was selected', () => {
    expect(rtpOutputUrl('rtp', '192.168.10.135', 1, 188)).toBe(
      'rtp://192.168.10.135:1?rtcpport=1&pkt_size=188'
    );
  });

  it('brackets an IPv6 destination', () => {
    expect(rtpOutputUrl('srtp', 'fe80::1', 9, 188, 'fe80::2')).toBe(
      'srtp://[fe80::1]:9?rtcpport=9&pkt_size=188&localaddr=fe80::2'
    );
  });
});
