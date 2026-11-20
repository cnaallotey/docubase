import dns from 'node:dns/promises';
import net from 'node:net';

/** Expand an IPv6 text address into 16 bytes, or null when it is not valid. */
function ipv6Bytes(text) {
  let ip = text.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    if (p.length !== 4 || p.some((n) => n > 255)) return null;
    ip = ip.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

function privateV4([a, b, c]) {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * True for addresses a user supplied URL must never reach: loopback, private, link local, cloud
 * metadata and so on. IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64, 6to4) are
 * unwrapped first, so ::ffff:7f00:1 is judged as 127.0.0.1.
 */
export function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) return privateV4(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) return true; // not an address we understand, so do not trust it
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return privateV4(b.slice(12)); // ::ffff:0:0/96 mapped
  if (zeros(0, 12)) return true; // ::/96 unspecified, loopback and the old IPv4 compatible form
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return privateV4(b.slice(12)); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return privateV4(b.slice(2, 6)); // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x01 && b[1] === 0 && zeros(2, 8)) return true; // 100::/64 discard
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** Resolve a hostname and refuse it when any address it points to is not public. */
export async function assertPublicHost(hostname, lookup = dns.lookup) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`${host} is not a public address`);
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error(`${host} is not a public host`);
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`${host} could not be resolved`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`${host} does not point to a public address`);
  }
}
