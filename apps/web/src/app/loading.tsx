/** Route-level loading state. On the free hosting plan the first request after an idle spell wakes the server, which can take up to a minute. */
export default function Loading() {
  return (
    <div className="stack-l cold-start" role="status" aria-live="polite" aria-busy="true">
      <div className="stack-s">
        <h1 className="cold-h">Waking the demo server</h1>
        <p className="muted">Free plan, up to 60 s. This page appears on its own as soon as the server answers; nothing is lost if you wait.</p>
      </div>
      <div className="kpis kpis-3" aria-hidden>
        <div className="skeleton cold-tile" />
        <div className="skeleton cold-tile" />
        <div className="skeleton cold-tile" />
      </div>
      <div className="skeleton cold-block" aria-hidden />
    </div>
  );
}
