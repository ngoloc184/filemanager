import "server-only";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { STICKER_MAX_BYTES, sniffImageMime, type StickerMime } from "../stickers/custom.ts";

// Downloads an image from a link an admin pasted, without letting the link
// reach this server's own network (SSRF):
// * https on the default port only, no user name or password in the link;
// * every address the host name resolves to must be public; the connection
//   uses the address that was checked (the check runs inside the socket's DNS
//   lookup), so a second, different DNS answer cannot slip in between;
// * redirects are followed by hand (at most 3) and each target is checked
//   again the same way;
// * 10 seconds in all, at most 2 MiB read (the download stops beyond), and
//   the type comes from the bytes, never from the Content-Type header.

export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 2048;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A refused or failed download; `status` is the HTTP status for our API's answer. */
export class SafeFetchError extends Error {
  status: 400 | 413 | 415 | 502;
  constructor(message: string, status: 400 | 413 | 415 | 502) {
    super(message);
    this.name = "SafeFetchError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- addresses

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p))) return null;
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

/** The 16 bytes of an IPv6 address (zone id ignored), or null. */
function parseIPv6(address: string): number[] | null {
  let text = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (isIP(text) !== 6) return null;
  // a dotted IPv4 tail ("::ffff:10.0.0.1") becomes two hex groups
  const tail = text.slice(text.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, text.length - tail.length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  let groups: string[];
  if (text.includes("::")) {
    const [head, rest] = text.split("::");
    const left = head ? head.split(":") : [];
    const right = rest ? rest.split(":") : [];
    groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  } else {
    groups = text.split(":");
  }
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

/** [first address, prefix length] of IPv4 ranges that are not the public internet. */
const BLOCKED_V4: [number[], number][] = [
  [[0, 0, 0, 0], 8], // "this network", unspecified
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, cloud metadata (169.254.169.254)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, broadcast
];

const toInt = (b: number[]) => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;

function isBlockedIPv4(bytes: number[]): boolean {
  const ip = toInt(bytes);
  return BLOCKED_V4.some(([base, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ip & mask) === (toInt(base) & mask);
  });
}

function isBlockedIPv6(b: number[]): boolean {
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d → the IPv4 rules
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIPv4(b.slice(12));
  // NAT64 64:ff9b::a.b.c.d → the IPv4 rules
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isBlockedIPv4(b.slice(12));
  // 6to4 2002:aabb:ccdd:: embeds a.b.c.d
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIPv4(b.slice(2, 6));
  // everything outside global unicast 2000::/3: ::, ::1, IPv4-compatible,
  // discard 100::/64, ULA fc00::/7 (fd00::/8, fd00:ec2::254), link-local
  // fe80::/10, site-local fec0::/10, multicast ff00::/8
  if ((b[0] & 0xe0) !== 0x20) return true;
  // IETF special purpose 2001::/23 (Teredo, ORCHID, ...), documentation
  // 2001:db8::/32 and 3fff::/20
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0) return true;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return true;
  return false;
}

/**
 * True when an IP address is not a public internet address (loopback,
 * private, link-local, CGNAT, ULA, multicast, unspecified, reserved,
 * documentation, IPv4-mapped/embedded forms of those) or is not an IP at all.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isBlockedIPv4(v4);
  const v6 = parseIPv6(address);
  if (v6) return isBlockedIPv6(v6);
  return true;
}

// ---------------------------------------------------------------- links

/** The link as a URL when it may be downloaded from; throws SafeFetchError (400) otherwise. */
export function checkImageUrl(input: string): URL {
  let url: URL;
  try {
    if (input.length > MAX_URL_LENGTH) throw new Error("too long");
    url = new URL(input.trim());
  } catch {
    throw new SafeFetchError("Enter a valid image link.", 400);
  }
  if (url.protocol !== "https:") throw new SafeFetchError("Only https:// links can be imported.", 400);
  if (url.username || url.password) throw new SafeFetchError("Links with a user name or password are not allowed.", 400);
  if (url.port !== "") throw new SafeFetchError("Links with a port number are not allowed.", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new SafeFetchError("Enter a valid image link.", 400);
  if (host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && isBlockedAddress(host))) {
    throw new SafeFetchError("This address is not allowed.", 400);
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
/** Resolves every address of a host name (dns.lookup with all: true). */
export type Resolver = (
  hostname: string,
  options: { all: true; family?: number },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

const systemResolver: Resolver = (hostname, options, callback) => dnsLookup(hostname, options, callback);

/**
 * A `lookup` for the socket that refuses a host name when any of its
 * addresses is not public, and connects to the addresses it checked.
 */
export function createSafeLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const family = options.family === 4 || options.family === 6 ? options.family : undefined;
    resolve(hostname, { all: true, ...(family ? { family } : {}) }, (err, addresses) => {
      if (err) return callback(err, []);
      if (!addresses?.length) {
        return callback(new SafeFetchError("The image server could not be found.", 502), []);
      }
      if (addresses.some((a) => isBlockedAddress(a.address))) {
        return callback(new SafeFetchError("This address is not allowed.", 400), []);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

// ---------------------------------------------------------------- download

/** One response, body not read yet. */
export type RawResponse = { status: number; headers: IncomingHttpHeaders; body: Readable };
export type Getter = (url: URL, signal: AbortSignal) => Promise<RawResponse>;

function httpsGetter(resolve?: Resolver): Getter {
  const lookup = createSafeLookup(resolve);
  return (url, signal) =>
    new Promise((done, fail) => {
      const req = httpsRequest(
        url,
        {
          method: "GET",
          // a fresh connection every time: a pooled socket was not checked here
          agent: false,
          lookup,
          signal,
          headers: {
            accept: "image/png,image/webp,image/gif,image/jpeg;q=0.9,*/*;q=0.1",
            "accept-encoding": "identity",
            "user-agent": "Mozilla/5.0 (compatible; StickerImport/1.0)",
          },
        },
        (res) => done({ status: res.statusCode ?? 0, headers: res.headers, body: res })
      );
      req.on("error", fail);
      req.end();
    });
}

function failure(err: unknown, signal: AbortSignal): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  if (signal.aborted) return new SafeFetchError("The image took too long to download.", 502);
  const code = (err as { code?: string } | null)?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new SafeFetchError("The image server could not be found.", 502);
  if (/CERT|SSL|TLS/i.test(code)) return new SafeFetchError("Could not connect securely to the image server.", 502);
  return new SafeFetchError("Could not download the image.", 502);
}

/** The body, at most `max` bytes; stops the download and throws (413) beyond. */
export async function readCapped(body: Readable, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    const part = typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
    total += part.byteLength;
    if (total > max) {
      body.destroy();
      throw new SafeFetchError("The image is larger than 2 MB.", 413);
    }
    chunks.push(part);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export type SafeFetchOptions = {
  timeoutMs?: number;
  /** DNS resolver for the safe lookup (tests) */
  resolve?: Resolver;
  /** replaces the https request (tests); links and redirects are still checked */
  get?: Getter;
};

/**
 * Downloads a sticker image from a public https link (see the rules at the
 * top of this file). Throws SafeFetchError with the status to answer:
 * 400 refused link, 413 too large, 415 not a PNG/WebP/GIF/JPEG, 502 the
 * remote server failed, answered badly or took too long.
 */
export async function fetchImageSafely(
  input: string,
  options: SafeFetchOptions = {}
): Promise<{ bytes: Uint8Array; mime: StickerMime }> {
  const url = checkImageUrl(input);
  const get = options.get ?? httpsGetter(options.resolve);
  const controller = new AbortController();
  // a plain timer (AbortSignal.timeout's does not keep the process alive)
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    return await download(url, get, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function download(start: URL, get: Getter, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: StickerMime }> {
  let url = start;
  for (let redirects = 0; ; redirects++) {
    let res: RawResponse;
    try {
      res = await get(url, signal);
    } catch (err) {
      throw failure(err, signal);
    }

    if (REDIRECTS.has(res.status)) {
      res.body.destroy();
      const location = res.headers.location;
      if (redirects >= MAX_REDIRECTS) throw new SafeFetchError("The link redirects too many times.", 502);
      if (!location) throw new SafeFetchError("The image server answered with a broken redirect.", 502);
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw new SafeFetchError("The image server answered with a broken redirect.", 502);
      }
      url = checkImageUrl(next);
      continue;
    }

    if (res.status !== 200) {
      res.body.destroy();
      throw new SafeFetchError(`The image server answered with error ${res.status}.`, 502);
    }
    const length = Number(res.headers["content-length"]);
    if (Number.isFinite(length) && length > STICKER_MAX_BYTES) {
      res.body.destroy();
      throw new SafeFetchError("The image is larger than 2 MB.", 413);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res.body, STICKER_MAX_BYTES);
    } catch (err) {
      throw failure(err, signal);
    }
    // a connection cut mid-body must not leave a truncated image
    if (signal.aborted || (res.body as { complete?: boolean }).complete === false) {
      throw failure(new Error("incomplete"), signal);
    }
    if (bytes.byteLength === 0) throw new SafeFetchError("The link returned an empty file.", 415);
    const mime = sniffImageMime(bytes);
    if (!mime) throw new SafeFetchError("The link is not a PNG, WebP, GIF or JPEG image.", 415);
    return { bytes, mime };
  }
}
