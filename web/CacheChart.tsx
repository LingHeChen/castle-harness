import React from "react";
import type { StepMetric } from "../src/core/analysis";

/**
 * Per-step token chart, hand-drawn in SVG (no chart dependency). Each step is a
 * stacked bar — cached (green) vs uncached (grey) input tokens — with the
 * cache-hit % drawn as a line over the top. The story it tells: input plateaus
 * under compaction, and hit% dips right after each cache reset.
 */
export function CacheChart({ steps }: { steps: StepMetric[] }) {
  const W = 640;
  const H = 220;
  const pad = { l: 44, r: 36, t: 16, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  if (steps.length === 0) {
    return <div className="chart-empty">no steps yet</div>;
  }

  const maxTok = Math.max(...steps.map((s) => s.inputTokens), 1);
  const n = steps.length;
  const slot = iw / n;
  const barW = Math.min(36, slot * 0.6);

  const x = (i: number) => pad.l + slot * i + (slot - barW) / 2;
  const yTok = (v: number) => pad.t + ih - (v / maxTok) * ih;
  const yHit = (r: number) => pad.t + ih - r * ih;

  const linePts = steps.map((s, i) => `${pad.l + slot * i + slot / 2},${yHit(s.hitRate)}`).join(" ");

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {/* y grid: token axis */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih * (1 - f)} y2={pad.t + ih * (1 - f)} className="grid" />
          <text x={pad.l - 6} y={pad.t + ih * (1 - f) + 3} className="axis" textAnchor="end">
            {Math.round((maxTok * f) / 100) / 10}k
          </text>
        </g>
      ))}

      {/* stacked bars: uncached + cached */}
      {steps.map((s, i) => {
        const uncached = s.inputTokens - s.cachedInputTokens;
        return (
          <g key={i}>
            <rect x={x(i)} y={yTok(s.inputTokens)} width={barW} height={pad.t + ih - yTok(uncached)} className="bar-uncached" />
            <rect
              x={x(i)}
              y={yTok(s.inputTokens)}
              width={barW}
              height={Math.max(0, yTok(uncached) - yTok(s.inputTokens))}
              className="bar-cached"
            />
            <text x={x(i) + barW / 2} y={H - 8} className="axis" textAnchor="middle">
              {s.step}
            </text>
          </g>
        );
      })}

      {/* hit% line */}
      <polyline points={linePts} className="hit-line" fill="none" />
      {steps.map((s, i) => (
        <circle key={i} cx={pad.l + slot * i + slot / 2} cy={yHit(s.hitRate)} r={2.5} className="hit-dot" />
      ))}

      {/* right axis: 0..100% */}
      {[0, 0.5, 1].map((f) => (
        <text key={f} x={W - pad.r + 6} y={yHit(f) + 3} className="axis" textAnchor="start">
          {Math.round(f * 100)}%
        </text>
      ))}
    </svg>
  );
}
