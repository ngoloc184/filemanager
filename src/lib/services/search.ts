import { createClient } from "@/lib/supabase/client";

export type SearchScope = "all" | "mine" | "shared";
export type SearchSortField = "name" | "size" | "created_at" | "updated_at";
export type SearchSortDir = "asc" | "desc";

export interface SearchFilters {
  query?: string;
  extension?: string;
  folderId?: string | null;
  minSize?: number | null;
  maxSize?: number | null;
  createdAfter?: string | null;
  createdBefore?: string | null;
  modifiedAfter?: string | null;
  modifiedBefore?: string | null;
  tag?: string;
  scope?: SearchScope;
  sort?: SearchSortField;
  dir?: SearchSortDir;
  page?: number;
  pageSize?: number;
}

export type SearchResult = {
  file_id: string;
  name: string;
  folder_id: string | null;
  folder_name: string | null;
  owner_id: string;
  extension: string;
  mime_type: string;
  size: number;
  is_public: boolean;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  total_count: number;
};

export type SearchPage = {
  results: SearchResult[];
  total: number;
  page: number;
  pageSize: number;
};

export async function searchFiles(
  filters: SearchFilters
): Promise<SearchPage> {
  const supabase = createClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;

  const { data, error } = await supabase.rpc("search_files", {
    p_query: filters.query ?? null,
    p_extension: filters.extension ?? null,
    p_folder_id: filters.folderId ?? null,
    p_min_size: filters.minSize ?? null,
    p_max_size: filters.maxSize ?? null,
    p_created_after: filters.createdAfter ?? null,
    p_created_before: filters.createdBefore ?? null,
    p_modified_after: filters.modifiedAfter ?? null,
    p_modified_before: filters.modifiedBefore ?? null,
    p_tag: filters.tag ?? null,
    p_scope: filters.scope ?? "all",
    p_sort: filters.sort ?? "name",
    p_dir: filters.dir ?? "asc",
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) throw error;

  const results = (data ?? []) as SearchResult[];
  return {
    results,
    total: results.length > 0 ? results[0].total_count : 0,
    page,
    pageSize,
  };
}
