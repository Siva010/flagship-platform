'use client';

export interface IntervalPoint {
  /** Cumulative users per arm at this checkpoint. */
  n: number;
  effect: number;
  lower: number;
  upper: number;
}

export interface IntervalSeries {
  label: string;
  color: string;
  points: IntervalPoint[];
  /** First checkpoint whose interval excluded zero, if any. */
  firstSignificantIndex?: number | undefined;
}

/**
 * Confidence intervals over time.
 *
 * Plotted as bands rather than a single number at the end, because the shape
 * over time is the whole argument. A fixed-horizon interval is only valid at
 * one pre-registered point; drawing it at every checkpoint shows exactly how
 * often it wanders across zero on the way there, which is what makes peeking
 * at it unsound. The always-valid band is wider and does not.
 *
 * Inline SVG rather than a charting library: two bands and a zero line do not
 * justify a dependency in a bundle whose size is a selling point.
 */
export function IntervalChart({
  series,
  width = 720,
  height = 280,
}: {
  series: IntervalSeries[];
  width?: number;
  height?: number;
}) {
  const margin = { top: 16, right: 16, bottom: 36, left: 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) return null;

  const maxN = Math.max(...allPoints.map((p) => p.n));
  const minN = Math.min(...allPoints.map((p) => p.n));

  // Symmetric around zero so the zero line sits mid-plot and a band crossing it
  // is immediately visible rather than something you have to look for.
  const extent = Math.max(...allPoints.map((p) => Math.max(Math.abs(p.lower), Math.abs(p.upper))));
  const yMax = extent * 1.1 || 0.01;

  const x = (n: number): number =>
    margin.left + ((n - minN) / Math.max(maxN - minN, 1)) * plotWidth;
  const y = (value: number): number =>
    margin.top + plotHeight / 2 - (value / yMax) * (plotHeight / 2);

  const bandPath = (points: IntervalPoint[]): string => {
    const upper = points.map((p) => `${x(p.n)},${y(p.upper)}`);
    const lower = [...points].reverse().map((p) => `${x(p.n)},${y(p.lower)}`);
    return `M ${upper.join(' L ')} L ${lower.join(' L ')} Z`;
  };

  const linePath = (points: IntervalPoint[]): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.n)},${y(p.effect)}`).join(' ');

  const formatPercent = (value: number): string => `${(value * 100).toFixed(1)}pp`;

  return (
    <figure className="chart">
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Confidence intervals over time for each analysis method"
      >
        {/* Zero line: the reference everything is judged against. */}
        <line
          x1={margin.left}
          x2={margin.left + plotWidth}
          y1={y(0)}
          y2={y(0)}
          className="chart__zero"
        />

        {series.map((s) => (
          <g key={s.label}>
            <path d={bandPath(s.points)} fill={s.color} fillOpacity={0.16} stroke="none" />
            <path d={linePath(s.points)} fill="none" stroke={s.color} strokeWidth={1.5} />
            {s.firstSignificantIndex !== undefined && s.points[s.firstSignificantIndex] && (
              <line
                x1={x(s.points[s.firstSignificantIndex]!.n)}
                x2={x(s.points[s.firstSignificantIndex]!.n)}
                y1={margin.top}
                y2={margin.top + plotHeight}
                stroke={s.color}
                strokeWidth={1}
                strokeDasharray="4 3"
              />
            )}
          </g>
        ))}

        {/* Y axis */}
        <text x={margin.left - 8} y={y(yMax) + 4} className="chart__tick" textAnchor="end">
          {formatPercent(yMax)}
        </text>
        <text x={margin.left - 8} y={y(0) + 4} className="chart__tick" textAnchor="end">
          0
        </text>
        <text x={margin.left - 8} y={y(-yMax) + 4} className="chart__tick" textAnchor="end">
          {formatPercent(-yMax)}
        </text>

        {/* X axis */}
        <text x={margin.left} y={height - 12} className="chart__tick">
          {minN.toLocaleString()}
        </text>
        <text x={margin.left + plotWidth} y={height - 12} className="chart__tick" textAnchor="end">
          {maxN.toLocaleString()} users/arm
        </text>
      </svg>

      <figcaption className="chart__legend">
        {series.map((s) => (
          <span key={s.label} className="chart__legend-item">
            <span className="chart__swatch" style={{ background: s.color }} />
            {s.label}
            {s.firstSignificantIndex !== undefined && (
              <em>
                {' '}
                — crossed at {s.points[s.firstSignificantIndex]?.n.toLocaleString()} users
              </em>
            )}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
