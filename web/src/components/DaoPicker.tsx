import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fmtInt, splitDao } from "../lib/format";
import type { DaoRow } from "../lib/snapshot";

const SHOW = 40;

/** Searchable list of crawled DAOs (ARIA combobox). */
export function DaoPicker({
  id,
  daos,
  value,
  onPick,
  placeholder = "Search DAOs by name",
  exclude,
  clearOnPick,
  label,
}: {
  id: string;
  daos: DaoRow[];
  value?: string;
  onPick: (dao: string) => void;
  placeholder?: string;
  exclude?: Set<string>;
  clearOnPick?: boolean;
  label?: string;
}) {
  const [query, setQuery] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = exclude ? daos.filter((d) => !exclude.has(d.dao)) : daos;
    if (!q || q === value) return base.slice(0, SHOW);
    const starts: DaoRow[] = [];
    const contains: DaoRow[] = [];
    for (const d of base) {
      const name = d.dao;
      if (name.startsWith(q)) starts.push(d);
      else if (name.includes(q)) contains.push(d);
      if (starts.length >= SHOW) break;
    }
    return [...starts, ...contains].slice(0, SHOW);
  }, [daos, query, exclude, value]);

  const pick = (dao: string) => {
    onPick(dao);
    setQuery(clearOnPick ? "" : dao);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const n = matches.length;
      if (!n) return;
      const next = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
      setActive(next);
      listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const m = matches[active];
      if (open && m) {
        e.preventDefault();
        pick(m.dao);
      } else if (query.includes(".")) {
        e.preventDefault();
        pick(query.trim().toLowerCase());
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="combo">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        aria-label={label}
        value={query}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={(e) => {
          setOpen(true);
          e.target.select();
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKey}
      />
      {open && (
        <ul className="combo-list" id={listId} role="listbox" ref={listRef}>
          {matches.length === 0 ? (
            <li className="combo-empty" role="presentation">
              No crawled DAO matches. Press Enter to use “{query.trim()}” anyway.
            </li>
          ) : (
            matches.map((d, i) => {
              const [name, rest] = splitDao(d.dao);
              return (
                <li
                  key={d.dao}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(d.dao);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="acct">
                    {name}
                    <span className="acct-rest">{rest}</span>
                  </span>
                  <span className="combo-count">{fmtInt(d.payouts)} payouts</span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
