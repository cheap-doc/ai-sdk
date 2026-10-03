// Which addresses an image URL may be fetched from.
//
// The model chooses `imageUrl`, and this code runs with the host application's
// network reach, so an unconstrained URL is a request-forgery primitive: it
// could make the application fetch a loopback service, a machine on its private
// network, or the cloud metadata endpoint, and upload the answer to the API.
// Only https addresses on the public internet are allowed.
//
// Everything here is pure apart from the resolver the caller injects, so the
// decisions are unit-testable without touching the network or DNS.

import { imageRefused } from "./errors.ts";

// Largest image body accepted from a URL, matching the 25 MB the API accepts.
// Without a ceiling a hostile or broken server could grow this process until
// it dies.
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

// How many hops a URL may redirect through before we give up. Redirects are
// followed by hand so every hop is re-checked; a chain longer than this is
// indistinguishable from a loop.
export const MAX_REDIRECTS = 3;

const BASE64_HINT = "Pass the image as imageBase64 instead.";

/** Resolves a hostname to its addresses. Shaped like `dns/promises` `lookup`. */
export type AddressLookup = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

// Parses an IPv6 literal into its eight 16-bit groups, accepting "::"
// compression and a trailing dotted-quad (`::ffff:127.0.0.1`). Returns null for
// anything that is not an IPv6 address.
function parseIpv6(value: string): number[] | null {
  let text = value;
  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return null;
  const trailing = text.slice(lastColon + 1);
  if (trailing.includes(".")) {
    const quad = parseIpv4(trailing);
    if (quad === null) return null;
    const high = ((quad[0] ?? 0) << 8) | (quad[1] ?? 0);
    const low = ((quad[2] ?? 0) << 8) | (quad[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const compression = text.indexOf("::");
  if (compression !== -1 && text.indexOf("::", compression + 1) !== -1) return null;

  let headParts: string[];
  let tailParts: string[];
  if (compression === -1) {
    headParts = text.split(":");
    tailParts = [];
  } else {
    const left = text.slice(0, compression);
    const right = text.slice(compression + 2);
    headParts = left === "" ? [] : left.split(":");
    tailParts = right === "" ? [] : right.split(":");
  }

  const fill = 8 - headParts.length - tailParts.length;
  if (compression === -1 ? fill !== 0 : fill < 1) return null;

  const groups: number[] = [];
  for (const part of headParts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  for (let i = 0; i < fill; i++) groups.push(0);
  for (const part of tailParts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups.length === 8 ? groups : null;
}

// Why an IPv4 address is not on the public internet, or null when it is.
function refuseIpv4(octets: number[]): string | null {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 0) return "an unspecified or this-network address";
  if (a === 127) return "a loopback address";
  if (a === 10) return "a private-network address";
  if (a === 172 && b >= 16 && b <= 31) return "a private-network address";
  if (a === 192 && b === 168) return "a private-network address";
  if (a === 169 && b === 254)
    return "a link-local address, which is where cloud instances serve their metadata and credentials";
  if (a === 100 && b >= 64 && b <= 127) return "a carrier-grade NAT address";
  if (a >= 224) return "a multicast, reserved or broadcast address";
  return null;
}

// Why an IPv6 address is not on the public internet, or null when it is.
// Addresses that merely wrap an IPv4 one are judged as that IPv4 address, so
// `::ffff:127.0.0.1` is refused for the same reason `127.0.0.1` is.
function refuseIpv6(groups: number[]): string | null {
  const first = groups[0] ?? 0;
  const leadingZero = groups.slice(0, 5).every((group) => group === 0);
  if (leadingZero && (groups[5] ?? 0) === 0xffff) {
    return refuseIpv4(ipv4FromGroups(groups));
  }
  if (leadingZero && (groups[5] ?? 0) === 0) {
    const tail = ((groups[6] ?? 0) << 16) | (groups[7] ?? 0);
    if (tail === 0) return "an unspecified address";
    if (tail === 1) return "a loopback address";
    // ::a.b.c.d — the deprecated IPv4-compatible form wrapping an IPv4 address.
    return refuseIpv4(ipv4FromGroups(groups));
  }
  if ((first & 0xfe00) === 0xfc00) return "a unique-local address";
  if ((first & 0xffc0) === 0xfe80) return "a link-local address";
  if ((first & 0xff00) === 0xff00) return "a multicast address";
  return null;
}

function ipv4FromGroups(groups: number[]): number[] {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/**
 * Why the address must not be connected to, or null when it is a public
 * internet address. A string that parses as neither IPv4 nor IPv6 is refused
 * rather than allowed: an address we cannot classify is not one we can trust.
 */
export function refuseAddress(address: string): string | null {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const withoutZone = bare.split("%")[0] ?? bare;
  const ipv4 = parseIpv4(withoutZone);
  if (ipv4 !== null) return refuseIpv4(ipv4);
  const ipv6 = parseIpv6(withoutZone);
  if (ipv6 !== null) return refuseIpv6(ipv6);
  return "not a recognizable IP address";
}

/** True when the host is written as an IP literal rather than a name. */
function asAddressLiteral(hostname: string): string | null {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (parseIpv4(bare) !== null || parseIpv6(bare) !== null) return bare;
  return null;
}

/**
 * Checks the URL's scheme and, when the host is an IP literal, its address —
 * the part of the decision that needs no name resolution.
 */
export function assertAllowedUrlTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw imageRefused(`imageUrl is not a valid URL: "${raw}". ${BASE64_HINT}`);
  }
  if (url.protocol !== "https:") {
    throw imageRefused(
      `imageUrl must be an https: URL; "${url.protocol}" is refused, because any other scheme ` +
        `lets a tool call reach local files or services. ${BASE64_HINT}`,
    );
  }
  const literal = asAddressLiteral(url.hostname);
  if (literal !== null) {
    const reason = refuseAddress(literal);
    if (reason !== null) {
      throw imageRefused(
        `imageUrl host "${url.hostname}" is ${reason}; only public internet addresses may be ` +
          `fetched. ${BASE64_HINT}`,
      );
    }
  }
  return url;
}

/**
 * The full URL check: scheme, literal address, and every address the hostname
 * resolves to. One non-public answer refuses the whole URL, so a name that
 * resolves to both a public and a private address gets no second chance.
 */
export async function assertAllowedImageUrl(raw: string, lookup: AddressLookup): Promise<URL> {
  const url = assertAllowedUrlTarget(raw);
  if (asAddressLiteral(url.hostname) !== null) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly { readonly address: string; readonly family: number }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw imageRefused(`imageUrl host "${hostname}" could not be resolved. ${BASE64_HINT}`);
  }
  if (addresses.length === 0) {
    throw imageRefused(`imageUrl host "${hostname}" resolved to no addresses. ${BASE64_HINT}`);
  }
  for (const entry of addresses) {
    const reason = refuseAddress(entry.address);
    if (reason !== null) {
      throw imageRefused(
        `imageUrl host "${hostname}" resolves to ${entry.address}, which is ${reason}; only ` +
          `public internet addresses may be fetched. ${BASE64_HINT}`,
      );
    }
  }
  return url;
}
