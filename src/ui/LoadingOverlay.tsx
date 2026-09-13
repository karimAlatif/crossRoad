type Props = {
  visible: boolean;
  label: string;
  detail?: string;
  fraction: number | null;
  failed: boolean;
};

/**
 * The only screen furniture left. It covers the canvas while the 16 MB city
 * streams in, then dissolves for good, leaving the scene on its own.
 */
export function LoadingOverlay({ visible, label, detail, fraction, failed }: Props) {
  const percent = fraction === null ? null : Math.round(Math.min(fraction, 1) * 100);

  return (
    <div className={`loader${visible ? "" : " loader--done"}`} aria-hidden={!visible}>
      <div className="loader__panel" role="status" aria-live="polite">
        <div className="loader__lights">
          <span className="loader__bulb loader__bulb--red" />
          <span className="loader__bulb loader__bulb--green" />
        </div>

        <p className="loader__title">blueMino</p>

        <div className={`loader__track${percent === null ? " loader__track--sweep" : ""}`}>
          <div
            className={`loader__fill${failed ? " loader__fill--failed" : ""}`}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>

        <p className="loader__status">
          {label}
          {percent !== null && !failed ? ` — ${percent}%` : ""}
        </p>

        {detail && <p className="loader__detail">{detail}</p>}
      </div>
    </div>
  );
}
