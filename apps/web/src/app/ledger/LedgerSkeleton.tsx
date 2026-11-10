/**
 * Placeholder for the ledger grid: the same box (see .ledger-box in globals.css) the grid mounts into, filled with skeleton rows,
 * so the page below it does not move when the grid replaces it (ledger layout shift).
 */
export function LedgerSkeleton({ label }: { label?: string }) {
  return (
    <div className="ledger-box ledger-skel" role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="skeleton ledger-skel-row" />
      ))}
    </div>
  );
}
