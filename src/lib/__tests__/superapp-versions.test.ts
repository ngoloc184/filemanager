import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedSuperAppRequest } from "../superapp.ts";
import {
  compareVersions,
  listMiniAppVersions,
  putMiniAppVersion,
  type MiniAppVersion,
  type MiniAppVersionStore,
} from "../superapp-versions.ts";

const TOKEN = "test-token";

function memoryStore(initial: MiniAppVersion[] = []): MiniAppVersionStore & {
  rows: Map<string, MiniAppVersion>;
} {
  const rows = new Map(initial.map((row) => [row.name, row]));
  const now = () => new Date().toISOString();
  return {
    rows,
    async list() {
      return [...rows.values()];
    },
    async get(name) {
      return rows.get(name) ?? null;
    },
    async insert(name, version) {
      if (rows.has(name)) return null;
      const row = { name, version, updatedAt: now() };
      rows.set(name, row);
      return row;
    },
    async update(name, expected, version) {
      if (rows.get(name)?.version !== expected) return null;
      const row = { name, version, updatedAt: now() };
      rows.set(name, row);
      return row;
    },
  };
}

function putRequest(body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/superapp/versions/transfer", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("compareVersions", () => {
  it("compares each part numerically, not as strings", () => {
    assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
    assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
    assert.ok(compareVersions("2.0.0", "10.0.0") < 0);
    assert.ok(compareVersions("1.2.10", "1.2.9") > 0);
  });

  it("treats equal versions (including leading zeros) as equal", () => {
    assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
    assert.equal(compareVersions("01.002.0", "1.2.0"), 0);
  });

  it("orders major before minor before patch", () => {
    assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
    assert.ok(compareVersions("0.3.0", "0.2.99") > 0);
  });

  it("handles numbers beyond the safe integer range", () => {
    assert.ok(compareVersions("0.0.99999999999999999999", "0.0.99999999999999999998") > 0);
  });

  it("rejects malformed versions", () => {
    assert.throws(() => compareVersions("1.0", "1.0.0"));
    assert.throws(() => compareVersions("1.0.0", "v1.0.0"));
  });
});

describe("PUT /api/superapp/versions/<name>", () => {
  let previousKey: string | undefined;
  beforeEach(() => {
    previousKey = process.env.SUPERAPP_API_KEY;
    process.env.SUPERAPP_API_KEY = TOKEN;
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.SUPERAPP_API_KEY;
    else process.env.SUPERAPP_API_KEY = previousKey;
  });

  const deps = (store: MiniAppVersionStore) => ({
    store,
    isAuthorized: isAuthorizedSuperAppRequest,
  });

  it("returns 401 without a token", async () => {
    const res = await putMiniAppVersion(putRequest({ version: "0.1.0" }, null), "transfer", deps(memoryStore()));
    assert.equal(res.status, 401);
  });

  it("returns 401 with a wrong token", async () => {
    const res = await putMiniAppVersion(putRequest({ version: "0.1.0" }, "nope"), "transfer", deps(memoryStore()));
    assert.equal(res.status, 401);
  });

  it("returns 401 when the server has no API key configured", async () => {
    delete process.env.SUPERAPP_API_KEY;
    const res = await putMiniAppVersion(putRequest({ version: "0.1.0" }), "transfer", deps(memoryStore()));
    assert.equal(res.status, 401);
  });

  it("returns 400 for an invalid name", async () => {
    for (const name of ["Transfer", "-transfer", "trans fer", "a".repeat(65)]) {
      const res = await putMiniAppVersion(putRequest({ version: "0.1.0" }), name, deps(memoryStore()));
      assert.equal(res.status, 400, name);
      assert.equal(typeof (await res.json()).error, "string");
    }
  });

  it("returns 400 for an invalid version or body", async () => {
    for (const body of [{ version: "0.1" }, { version: "v0.1.0" }, { version: 1 }, {}, "not json", "null"]) {
      const res = await putMiniAppVersion(putRequest(body), "transfer", deps(memoryStore()));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(typeof (await res.json()).error, "string");
    }
  });

  it("creates a record and returns 200 with name, version and updatedAt", async () => {
    const store = memoryStore();
    const res = await putMiniAppVersion(putRequest({ version: "0.1.0" }), "transfer", deps(store));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.name, "transfer");
    assert.equal(body.version, "0.1.0");
    assert.ok(!Number.isNaN(Date.parse(body.updatedAt)));
    assert.equal(store.rows.get("transfer")?.version, "0.1.0");
  });

  it("returns 409 when the version is not greater than the current one", async () => {
    const store = memoryStore([{ name: "transfer", version: "0.10.0", updatedAt: new Date().toISOString() }]);
    for (const version of ["0.10.0", "0.9.0", "0.2.5"]) {
      const res = await putMiniAppVersion(putRequest({ version }), "transfer", deps(store));
      assert.equal(res.status, 409, version);
    }
    assert.equal(store.rows.get("transfer")?.version, "0.10.0");
  });

  it("accepts a numerically greater version", async () => {
    const store = memoryStore([{ name: "transfer", version: "0.9.0", updatedAt: new Date().toISOString() }]);
    const res = await putMiniAppVersion(putRequest({ version: "0.10.0" }), "transfer", deps(store));
    assert.equal(res.status, 200);
    assert.equal(store.rows.get("transfer")?.version, "0.10.0");
  });

  it("returns 409 when another request changed the version concurrently", async () => {
    const store = memoryStore([{ name: "transfer", version: "0.1.0", updatedAt: new Date().toISOString() }]);
    store.update = async () => null;
    const res = await putMiniAppVersion(putRequest({ version: "0.2.0" }), "transfer", deps(store));
    assert.equal(res.status, 409);
  });

  it("returns 500 when the store fails", async () => {
    const store = memoryStore();
    store.get = async () => {
      throw new Error("db down");
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await putMiniAppVersion(putRequest({ version: "0.1.0" }), "transfer", deps(store));
      assert.equal(res.status, 500);
    } finally {
      console.error = originalError;
    }
  });
});

describe("GET /api/superapp/versions", () => {
  it("returns an empty map when there are no records", async () => {
    const res = await listMiniAppVersions(memoryStore());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { miniApps: {} });
  });

  it("returns versions keyed by mini-app name", async () => {
    const updatedAt = "2026-10-01T02:26:04.000Z";
    const res = await listMiniAppVersions(memoryStore([{ name: "transfer", version: "0.2.0", updatedAt }]));
    assert.deepEqual(await res.json(), {
      miniApps: { transfer: { version: "0.2.0", updatedAt } },
    });
  });
});
