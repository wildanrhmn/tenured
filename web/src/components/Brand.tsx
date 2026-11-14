/** The Tenured mark: a record that rises, the latest entry in bolt yellow. */
export function Mark({ className = "mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#0A0A0B" />
      <rect x="7.5" y="17" width="3.4" height="8" rx="1.2" fill="#fff" fillOpacity=".55" />
      <rect x="12.6" y="13" width="3.4" height="12" rx="1.2" fill="#fff" fillOpacity=".75" />
      <rect x="17.7" y="9.5" width="3.4" height="15.5" rx="1.2" fill="#fff" />
      <rect x="22.8" y="6" width="3.4" height="19" rx="1.2" fill="#FFC21A" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <>
      <Mark />
      <span>Tenured</span>
    </>
  );
}
