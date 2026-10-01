// Mini-app version API logic, kept free of framework and Supabase imports so
// it can be unit tested with `node --test` (see src/lib/__tests__).

export const MINI_APP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export type MiniAppVersion = {
  name: string;
  version: string;
  updatedAt: string;
};

export interface MiniAppVersionStore {
  list(): Promise<MiniAppVersion[]>;
  get(name: string): Promise<MiniAppVersion | null>;
  /** Creates the record; resolves null if it already exists. */
  insert(name: string, version: string): Promise<MiniAppVersion | null>;
  /**
   * Sets a new version only while the stored one still equals `expected`;
   * resolves null if another request changed it in the meantime.
   */
  update(
    name: string,
    expected: string,
    version: string
  ): Promise<MiniAppVersion | null>;
}

export type VersionApiDeps = {
  store: MiniAppVersionStore;
  isAuthorized: (request: Request) => boolean;
};

export function isValidMiniAppName(name: string): boolean {
  return MINI_APP_NAME_PATTERN.test(name);
}

export function isValidVersion(version: unknown): version is string {
  return typeof version === "string" && VERSION_PATTERN.test(version);
}

/** Compares two numeric strings of any length without precision loss. */
function compareNumeric(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Compares `major.minor.patch` versions part by part (so 0.10.0 > 0.9.0).
 * Returns a negative number, zero or a positive number.
 */
export function compareVersions(a: string, b: string): number {
  if (!isValidVersion(a) || !isValidVersion(b)) {
    throw new Error(`Invalid version: ${isValidVersion(a) ? b : a}`);
  }
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < 3; i += 1) {
    const result = compareNumeric(left[i], right[i]);
    if (result !== 0) return result;
  }
  return 0;
}

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** GET /api/superapp/versions */
export async function listMiniAppVersions(
  store: MiniAppVersionStore
): Promise<Response> {
  try {
    const rows = await store.list();
    const miniApps = Object.fromEntries(
      rows.map((row) => [
        row.name,
        { version: row.version, updatedAt: row.updatedAt },
      ])
    );
    return json({ miniApps });
  } catch (error) {
    console.error("Failed to list mini-app versions", error);
    return json({ error: "Failed to load versions" }, 500);
  }
}

/** PUT /api/superapp/versions/<name> with body `{ "version": "x.y.z" }` */
export async function putMiniAppVersion(
  request: Request,
  name: string,
  { store, isAuthorized }: VersionApiDeps
): Promise<Response> {
  if (!isAuthorized(request)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!isValidMiniAppName(name)) {
    return json(
      {
        error:
          "Invalid name: use 1-64 lowercase letters, digits, '_' or '-', starting with a letter or digit",
      },
      400
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON: { "version": "x.y.z" }' }, 400);
  }
  const version =
    typeof body === "object" && body !== null
      ? (body as { version?: unknown }).version
      : undefined;
  if (!isValidVersion(version)) {
    return json(
      { error: "Invalid version: expected major.minor.patch, e.g. 0.2.0" },
      400
    );
  }

  try {
    const current = await store.get(name);
    if (current && compareVersions(version, current.version) <= 0) {
      return json(
        {
          error: `Version must be greater than the current version ${current.version}`,
          currentVersion: current.version,
        },
        409
      );
    }

    const saved = current
      ? await store.update(name, current.version, version)
      : await store.insert(name, version);
    if (!saved) {
      return json(
        { error: "The version was changed by another request; retry" },
        409
      );
    }
    return json({
      name: saved.name,
      version: saved.version,
      updatedAt: saved.updatedAt,
    });
  } catch (error) {
    console.error("Failed to save mini-app version", error);
    return json({ error: "Failed to save version" }, 500);
  }
}
