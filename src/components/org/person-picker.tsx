"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { listOrgMembers, searchDirectory, type DirectoryPerson } from "@/lib/services/org";
import { memberLabel } from "@/lib/org";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

export type { DirectoryPerson };

// People seen by any picker on this page, so a preset value shows a name
// without another round-trip.
const known = new Map<string, DirectoryPerson>();
let everyone: Promise<void> | null = null;

function remember(people: DirectoryPerson[]) {
  for (const p of people) known.set(p.user_id, p);
}

/**
 * Looks up one member (former ones included) by id. The list is loaded once
 * and loaded again when the id is missing from it (e.g. someone who joined
 * after the first load).
 */
async function lookup(userId: string): Promise<DirectoryPerson | null> {
  if (known.has(userId)) return known.get(userId) ?? null;
  if (everyone) {
    await everyone;
    if (known.has(userId)) return known.get(userId) ?? null;
    everyone = null;
  }
  everyone = listOrgMembers(null, true)
    .then(remember)
    .catch((err: unknown) => {
      everyone = null;
      throw err;
    });
  await everyone;
  return known.get(userId) ?? null;
}

/**
 * Combobox over the company directory: type to search (debounced), arrow keys
 * move, Enter picks, Escape closes, the clear button empties the value.
 */
export function PersonPicker(props: {
  value: string | null;
  onChange: (userId: string | null, person: DirectoryPerson | null) => void;
  placeholder?: string;
  filter?: (p: DirectoryPerson) => boolean;
  disabled?: boolean;
  excludeIds?: string[];
  includeInactive?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
}) {
  const { value, onChange, filter, excludeIds, includeInactive = false, disabled } = props;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [selected, setSelected] = useState<DirectoryPerson | null>(
    value ? (known.get(value) ?? null) : null
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectoryPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  // Resolve a value set from outside (e.g. an existing department head).
  useEffect(() => {
    if (!value) return;
    if (selected?.user_id === value) return;
    let cancelled = false;
    lookup(value)
      .then((person) => {
        if (!cancelled) setSelected(person);
      })
      .catch(() => {
        // the id stays; the field just shows no name
      });
    return () => {
      cancelled = true;
    };
  }, [value, selected?.user_id]);

  // Debounced search while the list is open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      const request = includeInactive ? listOrgMembers(query, true) : searchDirectory(query);
      request
        .then((people) => {
          if (cancelled) return;
          remember(people);
          setResults(people);
          setError(null);
          setActive(0);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(getErrorMessage(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, includeInactive]);

  const excluded = new Set(excludeIds ?? []);
  const options = results.filter((p) => !excluded.has(p.user_id) && (!filter || filter(p)));
  const current = value && selected?.user_id === value ? selected : null;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  const pick = (person: DirectoryPerson) => {
    setSelected(person);
    setOpen(false);
    setQuery("");
    onChange(person.user_id, person);
  };

  const clear = () => {
    setSelected(null);
    setQuery("");
    onChange(null, null);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive(Math.min(activeIndex + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      if (open && options[activeIndex]) {
        e.preventDefault();
        pick(options[activeIndex]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        // keep an enclosing dialog open; only close the list
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setQuery("");
      }
    }
  };

  const shown = open ? query : current ? memberLabel(current) : value ? "…" : "";
  const optionId = (i: number) => `${listId}-option-${i}`;

  return (
    <div className={cn("relative", props.className)}>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          ref={inputRef}
          id={props.id}
          type="text"
          role="combobox"
          aria-label={props["aria-label"]}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[activeIndex] ? optionId(activeIndex) : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={props.placeholder ?? "Search people by name or email"}
          value={shown}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
            setQuery("");
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-8 pl-8 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
            current && !open && "font-medium"
          )}
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={clear}
            // keep focus handling simple: clear before the input's blur runs
            onMouseDown={(e) => e.preventDefault()}
            className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            aria-label="Clear selection"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {current && !open && (current.department_name || current.email) && (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {[current.email, current.department_name].filter(Boolean).join(" · ")}
        </p>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {loading && options.length === 0 && (
            <li className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground" role="presentation">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Searching…
            </li>
          )}
          {error && (
            <li className="px-2 py-1.5 text-sm text-destructive" role="presentation">
              {error}
            </li>
          )}
          {!loading && !error && options.length === 0 && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground" role="presentation">
              No people found
            </li>
          )}
          {options.map((p, i) => (
            <li
              key={p.user_id}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              // pick before the input blurs and closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "cursor-default rounded-md px-2 py-1.5",
                i === activeIndex && "bg-accent text-accent-foreground"
              )}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{memberLabel(p)}</span>
                {p.status !== "active" && (
                  <span className="shrink-0 text-xs text-muted-foreground">({p.status})</span>
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {[p.email, p.department_name].filter(Boolean).join(" · ")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
