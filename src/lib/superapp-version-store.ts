import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  MiniAppVersion,
  MiniAppVersionStore,
} from "@/lib/superapp-versions";

type VersionRow = { name: string; version: string; updated_at: string };

const TABLE = "superapp_versions";
const COLUMNS = "name, version, updated_at";
const UNIQUE_VIOLATION = "23505";

function toMiniAppVersion(row: VersionRow): MiniAppVersion {
  return {
    name: row.name,
    version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Supabase-backed store (service role, server only). */
export function createSupabaseVersionStore(): MiniAppVersionStore {
  // Created on first use so configuration errors surface as handled 500s.
  let client: ReturnType<typeof createAdminClient> | null = null;
  const db = () => (client ??= createAdminClient());

  return {
    async list() {
      const { data, error } = await db()
        .from(TABLE)
        .select(COLUMNS)
        .order("name")
        .returns<VersionRow[]>();
      if (error) throw error;
      return (data ?? []).map(toMiniAppVersion);
    },

    async get(name) {
      const { data, error } = await db()
        .from(TABLE)
        .select(COLUMNS)
        .eq("name", name)
        .maybeSingle<VersionRow>();
      if (error) throw error;
      return data ? toMiniAppVersion(data) : null;
    },

    async insert(name, version) {
      const { data, error } = await db()
        .from(TABLE)
        .insert({ name, version })
        .select(COLUMNS)
        .single<VersionRow>();
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return null;
        throw error;
      }
      return toMiniAppVersion(data);
    },

    async update(name, expected, version) {
      // updated_at is set to now() by a database trigger.
      const { data, error } = await db()
        .from(TABLE)
        .update({ version })
        .eq("name", name)
        .eq("version", expected)
        .select(COLUMNS)
        .maybeSingle<VersionRow>();
      if (error) throw error;
      return data ? toMiniAppVersion(data) : null;
    },
  };
}
