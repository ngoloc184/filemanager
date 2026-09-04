"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import { format } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  File,
  FolderOpen,
  Loader2,
  Search,
  SlidersHorizontal,
  Tag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  searchFiles,
  type SearchFilters,
  type SearchScope,
  type SearchResult,
  type SearchSortDir,
  type SearchSortField,
} from "@/lib/services/search";
import { listMyTags, type MyTag } from "@/lib/services/tags";
import { downloadFile } from "@/lib/services/files";
import { getErrorMessage } from "@/lib/types/database";
import { cn, formatBytes } from "@/lib/utils";
import { PreviewDialog } from "@/components/files/file-dialogs";

const PAGE_SIZE = 25;

function toMB(bytes: number): number {
  return bytes * 1024 * 1024;
}

export default function SearchClient({
  user,
}: {
  user: { id: string; email?: string };
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [extension, setExtension] = useState("");
  const [tag, setTag] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [minSizeMB, setMinSizeMB] = useState("");
  const [maxSizeMB, setMaxSizeMB] = useState("");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");

  const [sort, setSort] = useState<SearchSortField>("updated_at");
  const [dir, setDir] = useState<SearchSortDir>("desc");
  const [page, setPage] = useState(1);

  const filterKey = [
    debouncedQuery,
    extension,
    tag,
    scope,
    minSizeMB,
    maxSizeMB,
    createdAfter,
    createdBefore,
    sort,
    dir,
  ].join("|");
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    // reset to first page whenever the search criteria change
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [myTags, setMyTags] = useState<MyTag[]>([]);
  const [preview, setPreview] = useState<SearchResult | null>(null);

  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    // load the user's tags for the filter dropdown
    listMyTags()
      .then(setMyTags)
      .catch(() => setMyTags([]));
  }, []);

  const runSearch = useCallback(
    async (pageToLoad: number) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const filters: SearchFilters = {
          query: debouncedQuery || undefined,
          extension: extension || undefined,
          tag: tag || undefined,
          scope,
          minSize: minSizeMB ? Math.round(toMB(Number(minSizeMB))) : null,
          maxSize: maxSizeMB ? Math.round(toMB(Number(maxSizeMB))) : null,
          createdAfter: createdAfter
            ? new Date(createdAfter).toISOString()
            : null,
          createdBefore: createdBefore
            ? new Date(`${createdBefore}T23:59:59`).toISOString()
            : null,
          sort,
          dir,
          page: pageToLoad,
          pageSize: PAGE_SIZE,
        };
        const outcome = await searchFiles(filters);
        if (id !== requestId.current) return;
        setResults(outcome.results);
        setTotal(outcome.total);
      } catch (err) {
        if (id !== requestId.current) return;
        setError(getErrorMessage(err));
        setResults([]);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [
      debouncedQuery,
      extension,
      tag,
      scope,
      minSizeMB,
      maxSizeMB,
      createdAfter,
      createdBefore,
      sort,
      dir,
    ]
  );

  useEffect(() => {
    // run the search (debounced query + filters + page)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runSearch(page);
  }, [runSearch, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleDownload = async (row: SearchResult) => {
    try {
      await downloadFile({
        id: row.file_id,
        name: row.name,
        current_version_id: row.current_version_id,
      });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const clearFilters = () => {
    setExtension("");
    setTag("");
    setScope("all");
    setMinSizeMB("");
    setMaxSizeMB("");
    setCreatedAfter("");
    setCreatedBefore("");
  };

  const hasActiveFilters =
    extension !== "" ||
    tag !== "" ||
    scope !== "all" ||
    minSizeMB !== "" ||
    maxSizeMB !== "" ||
    createdAfter !== "" ||
    createdBefore !== "";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Search</h2>
        <p className="text-muted-foreground mt-1">
          Search across all files you can access.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by file name..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-10"
            autoFocus
          />
        </div>
        <Button
          variant={showFilters || hasActiveFilters ? "default" : "outline"}
          onClick={() => setShowFilters((v) => !v)}
          className="shrink-0"
        >
          <SlidersHorizontal className="h-4 w-4 mr-2" />
          Filters
          {hasActiveFilters && (
            <Badge variant="secondary" className="ml-2">
              active
            </Badge>
          )}
        </Button>
      </div>

      {showFilters && (
        <div className="rounded-xl border bg-white p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Extension</label>
            <Input
              placeholder="pdf, png..."
              value={extension}
              onChange={(e) => setExtension(e.target.value.toLowerCase())}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Tag</label>
            <Select value={tag || "all"} onValueChange={(v) => setTag(!v || v === "all" ? "" : v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Any tag" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any tag</SelectItem>
                {myTags.map((t) => (
                  <SelectItem key={t.tag_id} value={t.name}>
                    #{t.name} ({t.file_count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Ownership</label>
            <Select value={scope} onValueChange={(v) => v && setScope(v as SearchScope)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All files</SelectItem>
                <SelectItem value="mine">My files</SelectItem>
                <SelectItem value="shared">Shared with me</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Size (MB)</label>
            <div className="flex gap-2">
              <Input
                placeholder="Min"
                type="number"
                min="0"
                value={minSizeMB}
                onChange={(e) => setMinSizeMB(e.target.value)}
              />
              <Input
                placeholder="Max"
                type="number"
                min="0"
                value={maxSizeMB}
                onChange={(e) => setMaxSizeMB(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Created from</label>
            <Input
              type="date"
              value={createdAfter}
              onChange={(e) => setCreatedAfter(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Created to</label>
            <Input
              type="date"
              value={createdBefore}
              onChange={(e) => setCreatedBefore(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button variant="ghost" size="sm" onClick={clearFilters} disabled={!hasActiveFilters}>
              Clear filters
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">
          {results === null ? "Searching..." : `${total} result${total === 1 ? "" : "s"}`}
        </p>
        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(v) => v && setSort(v as SearchSortField)}>
            <SelectTrigger className="w-40 h-8">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="size">Size</SelectItem>
              <SelectItem value="created_at">Created</SelectItem>
              <SelectItem value="updated_at">Modified</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))}
            aria-label="Toggle sort direction"
          >
            {dir === "asc" ? "Asc" : "Desc"}
          </Button>
        </div>
      </div>

      {loading && results === null ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-14 rounded-xl border bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => void runSearch(page)}>
            Retry
          </Button>
        </div>
      ) : results && results.length === 0 ? (
        <div className="rounded-xl border bg-white flex flex-col items-center justify-center py-16 px-4">
          <Search className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">No results</h3>
          <p className="text-muted-foreground mt-1 text-center">
            Try a different search or adjust your filters.
          </p>
        </div>
      ) : (
        <div className={cn("rounded-xl border bg-white divide-y", loading && "opacity-60")}>
          {results?.map((row) => (
            <div
              key={row.file_id}
              className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50"
              onClick={() => setPreview(row)}
            >
              <File className="h-5 w-5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{row.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {formatBytes(row.size)} • {row.mime_type}
                  {row.folder_name ? ` • in ${row.folder_name}` : ""}
                  {" • "}
                  {format(new Date(row.updated_at), "MMM d, yyyy")}
                </p>
              </div>
              {row.is_public && (
                <Badge variant="secondary" className="shrink-0">
                  Public
                </Badge>
              )}
              {row.owner_id !== user.id && (
                <Badge variant="outline" className="shrink-0">
                  Shared
                </Badge>
              )}
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreview(row);
                  }}
                  aria-label={`Preview ${row.name}`}
                >
                  <Eye className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDownload(row);
                  }}
                  aria-label={`Download ${row.name}`}
                >
                  <Download className="h-4 w-4" />
                </Button>
                {row.folder_id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/dashboard?folder=${row.folder_id}`);
                    }}
                    aria-label="Open containing folder"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {results !== null && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Prev
          </Button>
          <span className="text-sm text-muted-foreground px-2">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}

      {loading && results !== null && (
        <div className="flex justify-center py-2">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {preview && (
        <PreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
          file={{
            id: preview.file_id,
            name: preview.name,
            current_version_id: preview.current_version_id,
            mime_type: preview.mime_type,
            size: preview.size,
          }}
        />
      )}

      {myTags.length === 0 && showFilters && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Tag className="h-3 w-3" />
          No tags yet. Add tags to files from their Details dialog.
        </p>
      )}
    </div>
  );
}
