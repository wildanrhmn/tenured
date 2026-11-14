import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { splitDao } from "../lib/format";
import type { Loadable } from "../lib/useSnapshot";

export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {children && <div className="lede">{children}</div>}
    </header>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  id,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <p className="field-error" id={`${id}-msg`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${id}-msg`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({
  id,
  value,
  onChange,
  invalid,
  ...rest
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "id">) {
  return (
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      aria-describedby={`${id}-msg`}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      {...rest}
    />
  );
}

/** "name.sputnik-dao.near" with the factory suffix dimmed. */
export function DaoName({ dao }: { dao: string }) {
  const [name, rest] = splitDao(dao);
  return (
    <span className="acct">
      {name}
      <span className="acct-rest">{rest}</span>
    </span>
  );
}

/** A claim pointer: dao#proposal. */
export function Pointer({ dao, id }: { dao: string; id: number }) {
  return (
    <span className="pointer">
      <DaoName dao={dao} />
      <span className="pointer-hash">#</span>
      {id}
    </span>
  );
}

export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <figure className="copy">
      <figcaption id={id}>
        <span>{label}</span>
        <button type="button" className="btn-quiet" onClick={copy} aria-describedby={id}>
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre tabIndex={0} aria-labelledby={id}>
        <code>{text}</code>
      </pre>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </figure>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="state" role="status">
      <span className="spinner" aria-hidden="true" />
      {what}
    </div>
  );
}

export function Failed({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p>{error}</p>
      {retry && (
        <button type="button" className="btn" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Gate<T>({ load, what, children }: { load: Loadable<T>; what: string; children: (v: T) => ReactNode }) {
  if (load.status === "loading") return <Loading what={what} />;
  if (load.status === "error") return <Failed error={load.error} retry={load.retry} />;
  return <>{children(load.value)}</>;
}

/** RULES.md rule 9, as a checkbox. */
export function ExcludeMembers({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="check-field">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-msg`} />
      <div>
        <label htmlFor={id}>Exclude payouts to the paying DAO's own members</label>
        <p className="field-hint" id={`${id}-msg`}>
          A council paying itself doesn't build a record. Membership is each DAO's current policy.
        </p>
      </div>
    </div>
  );
}

/** Ledger line: label, dotted leader, figure. */
export function Row({ label, value, note, tone }: { label: ReactNode; value: ReactNode; note?: ReactNode; tone?: "accent" | "veto" | "ok" | "no" }) {
  return (
    <div className={`row${tone ? ` row-${tone}` : ""}`}>
      <dt>
        <span>{label}</span>
        {note && <small>{note}</small>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

export function TrustedList({
  daos,
  onRemove,
  locked,
}: {
  daos: string[];
  onRemove: (dao: string) => void;
  locked?: string;
}) {
  if (daos.length === 0) return <p className="muted small">No DAOs trusted yet. Add one below.</p>;
  return (
    <ul className="chips">
      {daos.map((d) => (
        <li key={d} className="chip">
          <DaoName dao={d} />
          {d === locked && <span className="chip-tag">this DAO</span>}
          <button type="button" onClick={() => onRemove(d)} aria-label={`Stop trusting ${d}`}>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  );
}
