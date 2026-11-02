import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { Readable } from "node:stream";
import {
  MAX_REDIRECTS,
  SafeFetchError,
  checkImageUrl,
  createSafeLookup,
  fetchImageSafely,
  isBlockedAddress,
  readCapped,
  type Getter,
  type RawResponse,
  type Resolver,
} from "../net/safe-fetch.ts";
import { STICKER_MAX_BYTES } from "../stickers/custom.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function response(status: number, headers: Record<string, string> = {}, chunks: Uint8Array[] = []): RawResponse {
  return { status, headers, body: Readable.from(chunks) };
}

/** A fake server: answers by URL, records what was requested. */
function server(routes: Record<string, () => RawResponse>) {
  const requested: string[] = [];
  const get: Getter = async (url) => {
    requested.push(url.toString());
    const route = routes[url.toString()];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route();
  };
  return { get, requested };
}

async function rejectsWith(promise: Promise<unknown>, status: number, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof SafeFetchError, `expected SafeFetchError, got ${String(err)}`);
    assert.equal(err.status, status, err.message);
    if (message) assert.match(err.message, message);
    return true;
  });
}

const resolverFor =
  (answers: Record<string, string[]>): Resolver =>
  (hostname, _options, callback) => {
    const list = answers[hostname];
    if (!list) {
      const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
      return callback(err, []);
    }
    callback(
      null,
      list.map((address): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 }))
    );
  };

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, CGNAT, multicast and reserved IPv4", () => {
    for (const ip of [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "127.10.20.30",
      "169.254.169.254",
      "169.254.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.10",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  it("allows public IPv4, including neighbours of the blocked ranges", () => {
    for (const ip of [
      "1.1.1.1",
      "8.8.8.8",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.1",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "223.255.255.255",
    ]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  it("blocks special IPv6 ranges and IPv4 hidden inside IPv6", () => {
    for (const ip of [
      "::",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::127.0.0.1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:a00:1::",
      "2002:7f00:1::1",
      "100::1",
      "fc00::1",
      "fd00::1",
      "fd00:ec2::254",
      "fe80::1",
      "fe80::1%eth0",
      "fec0::1",
      "ff02::1",
      "2001::1",
      "2001:db8::1",
      "3fff::1",
      "[::1]",
    ]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  it("allows public IPv6 and public IPv4 inside IPv6", () => {
    for (const ip of [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2a00:1450:4001:80b::200e",
      "::ffff:8.8.8.8",
      "64:ff9b::8.8.8.8",
      "2002:808:808::1",
    ]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  it("treats anything that is not an IP address as blocked", () => {
    for (const value of ["", "localhost", "example.com", "1.2.3", "1.2.3.256", "01.2.3.4", "0x7f.0.0.1", "::g", "1::2::3"]) {
      assert.equal(isBlockedAddress(value), true, value);
    }
  });
});

describe("checkImageUrl", () => {
  it("accepts a public https link", () => {
    assert.equal(checkImageUrl("https://cdn.example.com/cat.png?x=1").hostname, "cdn.example.com");
    assert.equal(checkImageUrl("  https://example.com:443/a.gif ").port, "", "the default port is fine");
  });

  it("refuses links that are not plain https", () => {
    for (const url of [
      "http://example.com/a.png",
      "ftp://example.com/a.png",
      "file:///etc/passwd",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "https://user:pass@example.com/a.png",
      "https://user@example.com/a.png",
      "https://example.com:8443/a.png",
      "https://example.com:80/a.png",
      "not a link",
      "",
      `https://example.com/${"a".repeat(2100)}`,
    ]) {
      assert.throws(() => checkImageUrl(url), (err: unknown) => err instanceof SafeFetchError && err.status === 400, url);
    }
  });

  it("refuses local names and non-public IP literals in every spelling", () => {
    for (const url of [
      "https://localhost/a.png",
      "https://LOCALHOST./a.png",
      "https://api.localhost/a.png",
      "https://127.0.0.1/a.png",
      "https://2130706433/a.png",
      "https://0x7f.1/a.png",
      "https://0177.0.0.1/a.png",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/a.png",
      "https://[::ffff:127.0.0.1]/a.png",
      "https://[fd00:ec2::254]/a.png",
      "https://10.1.2.3/a.png",
    ]) {
      assert.throws(() => checkImageUrl(url), (err: unknown) => err instanceof SafeFetchError && err.status === 400, url);
    }
  });
});

describe("createSafeLookup", () => {
  const lookup = createSafeLookup(
    resolverFor({
      "public.example": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
      "mixed.example": ["93.184.215.14", "10.0.0.7"],
      "metadata.example": ["169.254.169.254"],
      "v6local.example": ["fd00::5"],
    })
  );
  const run = (hostname: string, all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
      lookup(hostname, { all }, (err, address, family) => resolve({ err, address, family }))
    );

  it("hands the socket the checked addresses", async () => {
    const one = await run("public.example", false);
    assert.equal(one.err, null);
    assert.equal(one.address, "93.184.215.14");
    assert.equal(one.family, 4);
    const all = await run("public.example", true);
    assert.equal(all.err, null);
    assert.equal((all.address as LookupAddress[]).length, 2);
  });

  it("refuses a name when any of its addresses is not public", async () => {
    for (const host of ["mixed.example", "metadata.example", "v6local.example"]) {
      const { err } = await run(host, false);
      assert.ok(err instanceof SafeFetchError && err.status === 400, host);
    }
  });

  it("passes DNS errors on", async () => {
    const { err } = await run("missing.example", false);
    assert.equal(err?.code, "ENOTFOUND");
  });
});

describe("readCapped", () => {
  it("joins the chunks", async () => {
    const bytes = await readCapped(Readable.from([Uint8Array.of(1, 2), Uint8Array.of(3)]), 10);
    assert.deepEqual([...bytes], [1, 2, 3]);
  });

  it("stops reading past the limit", async () => {
    let pulled = 0;
    const endless = new Readable({
      read() {
        pulled++;
        this.push(new Uint8Array(1024));
      },
    });
    await rejectsWith(readCapped(endless, 4096), 413);
    assert.ok(pulled < 100, `read ${pulled} chunks`);
    assert.equal(endless.destroyed, true);
  });
});

describe("fetchImageSafely", () => {
  it("downloads an image and takes its type from the bytes", async () => {
    const { get } = server({
      "https://img.example/cat": () => response(200, { "content-type": "text/html" }, [PNG.slice(0, 5), PNG.slice(5)]),
    });
    const result = await fetchImageSafely("https://img.example/cat", { get });
    assert.equal(result.mime, "image/png");
    assert.deepEqual([...result.bytes], [...PNG]);
  });

  it("refuses something that is not an image even when the header says so", async () => {
    const { get } = server({
      "https://img.example/x.png": () =>
        response(200, { "content-type": "image/png" }, [new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")]),
      "https://img.example/empty.png": () => response(200, {}, []),
    });
    await rejectsWith(fetchImageSafely("https://img.example/x.png", { get }), 415);
    await rejectsWith(fetchImageSafely("https://img.example/empty.png", { get }), 415);
  });

  it("refuses a body over 2 MiB, by header or while streaming", async () => {
    const { get } = server({
      "https://img.example/big-header": () => response(200, { "content-length": String(STICKER_MAX_BYTES + 1) }, [PNG]),
      "https://img.example/big-body": () =>
        response(200, {}, [PNG, new Uint8Array(STICKER_MAX_BYTES / 2), new Uint8Array(STICKER_MAX_BYTES / 2)]),
      "https://img.example/exact": () =>
        response(200, {}, [PNG, new Uint8Array(STICKER_MAX_BYTES - PNG.byteLength)]),
    });
    await rejectsWith(fetchImageSafely("https://img.example/big-header", { get }), 413);
    await rejectsWith(fetchImageSafely("https://img.example/big-body", { get }), 413);
    const exact = await fetchImageSafely("https://img.example/exact", { get });
    assert.equal(exact.bytes.byteLength, STICKER_MAX_BYTES);
  });

  it("reports server errors as 502", async () => {
    const { get } = server({ "https://img.example/gone": () => response(404) });
    await rejectsWith(fetchImageSafely("https://img.example/gone", { get }), 502, /404/);
    const failing: Getter = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    await rejectsWith(fetchImageSafely("https://nowhere.example/a.png", { get: failing }), 502, /could not be found/);
  });

  it("follows up to 3 redirects, relative ones included", async () => {
    const { get, requested } = server({
      "https://a.example/1": () => response(301, { location: "https://b.example/2" }),
      "https://b.example/2": () => response(302, { location: "/3" }),
      "https://b.example/3": () => response(307, { location: "../img/4.png" }),
      "https://b.example/img/4.png": () => response(200, {}, [PNG]),
    });
    const result = await fetchImageSafely("https://a.example/1", { get });
    assert.equal(result.mime, "image/png");
    assert.equal(requested.length, 1 + MAX_REDIRECTS);
  });

  it("stops after 3 redirects", async () => {
    const { get, requested } = server({
      "https://a.example/1": () => response(301, { location: "/2" }),
      "https://a.example/2": () => response(301, { location: "/3" }),
      "https://a.example/3": () => response(301, { location: "/4" }),
      "https://a.example/4": () => response(301, { location: "/5" }),
      "https://a.example/5": () => response(200, {}, [PNG]),
    });
    await rejectsWith(fetchImageSafely("https://a.example/1", { get }), 502, /redirects/);
    assert.equal(requested.length, 4, "the fifth link is never requested");
  });

  it("checks every redirect target again", async () => {
    for (const location of [
      "http://img.example/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://169.254.169.254/latest/meta-data/",
      "https://img.example:8080/a.png",
      "https://admin:secret@img.example/a.png",
      "https://localhost/a.png",
    ]) {
      const { get, requested } = server({ "https://a.example/start": () => response(302, { location }) });
      await rejectsWith(fetchImageSafely("https://a.example/start", { get }), 400);
      assert.equal(requested.length, 1, location);
    }
    const { get } = server({ "https://a.example/start": () => response(302) });
    await rejectsWith(fetchImageSafely("https://a.example/start", { get }), 502, /redirect/);
  });

  it("refuses a bad link before any request", async () => {
    const { get, requested } = server({});
    await rejectsWith(fetchImageSafely("http://img.example/a.png", { get }), 400);
    await rejectsWith(fetchImageSafely("https://10.0.0.1/a.png", { get }), 400);
    assert.equal(requested.length, 0);
  });

  it("gives up after the time limit", async () => {
    const slow: Getter = (_url, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    await rejectsWith(fetchImageSafely("https://slow.example/a.png", { get: slow, timeoutMs: 30 }), 502, /too long/);
  });

  it("never connects to a host name that resolves to a private address", async () => {
    // the real https request with a fake DNS: refused inside the socket's lookup
    const resolve = resolverFor({ "intranet.example": ["10.0.0.5"], "meta.example": ["169.254.169.254"] });
    await rejectsWith(fetchImageSafely("https://intranet.example/a.png", { resolve, timeoutMs: 2000 }), 400);
    await rejectsWith(fetchImageSafely("https://meta.example/a.png", { resolve, timeoutMs: 2000 }), 400);
  });
});
