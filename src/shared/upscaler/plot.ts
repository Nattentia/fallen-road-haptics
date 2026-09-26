import type { Score } from './contract';
import { bakeCurves, TRANSIENT_EQUIV_MS } from './score';

/**
 * Samples scores into intensity and sharpness curves over time, one series
 * per layer, for the comparison graphs (base vs upscale layer).
 */

export type Sample = { t: number; intensity: number; sharpness: number };

export const sampleLayer = (
  scores: readonly Score[],
  from: number,
  to: number,
  stepMs = 2
): Sample[] => {
  const baked = scores.map((s) => bakeCurves(s, stepMs));
  const out: Sample[] = [];
  for (let t = from; t <= to; t += stepMs) {
    let intensity = 0;
    let weighted = 0;
    for (const s of baked)
      for (const e of s.events) {
        const start = s.at + e.t;
        const span = e.kind === 'continuous' ? e.duration : TRANSIENT_EQUIV_MS;
        if (t < start || t >= start + span) continue;
        intensity += e.intensity;
        weighted += e.intensity * e.sharpness;
      }
    out.push({
      t: t - from,
      intensity,
      sharpness: intensity > 0 ? weighted / intensity : 0,
    });
  }
  return out;
};

/** A small self-contained SVG: intensity (solid) and sharpness (dashed). */
export const plotSvg = (
  title: string,
  series: readonly { label: string; colour: string; samples: Sample[] }[],
  width = 720,
  height = 240
): string => {
  const pad = 32;
  const span = Math.max(1, ...series.flatMap((s) => s.samples.map((p) => p.t)));
  const x = (t: number) => pad + ((width - 2 * pad) * t) / span;
  const y = (v: number) =>
    height - pad - ((height - 2 * pad) * Math.min(1.2, v)) / 1.2;
  const path = (samples: Sample[], key: 'intensity' | 'sharpness') =>
    samples
      .map(
        (p, i) =>
          `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`
      )
      .join(' ');
  const lines = series
    .map(
      (s) =>
        `<path d="${path(s.samples, 'intensity')}" fill="none" stroke="${s.colour}" stroke-width="2"/>` +
        `<path d="${path(s.samples, 'sharpness')}" fill="none" stroke="${s.colour}" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>`
    )
    .join('');
  const legend = series
    .map(
      (s, i) =>
        `<text x="${width - pad - 180}" y="${pad + 14 * i}" fill="${s.colour}" font-size="11">${s.label}: intensity (solid), sharpness (dashed)</text>`
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif">
<rect width="100%" height="100%" fill="#fff"/>
<text x="${pad}" y="18" font-size="13">${title}</text>
<line x1="${pad}" y1="${y(1)}" x2="${width - pad}" y2="${y(1)}" stroke="#ccc" stroke-dasharray="2 2"/>
<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#999"/>
<text x="${width - pad}" y="${height - 10}" font-size="10" text-anchor="end">${Math.round(span)} ms</text>
${lines}${legend}
</svg>
`;
};
