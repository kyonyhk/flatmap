// Sequential blue ramp (reference palette steps 100→700), anchored for the
// dark surface: darkest step = cheapest, lightest = most expensive.
export const RAMP = [
  "#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5",
  "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb",
];

export const hexToRgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

// 256-entry interpolated lookup table.
export const LUT: [number, number, number][] = [];
for (let i = 0; i < 256; i++) {
  const t = (i / 255) * (RAMP.length - 1);
  const a = hexToRgb(RAMP[Math.floor(t)]);
  const b = hexToRgb(RAMP[Math.min(RAMP.length - 1, Math.floor(t) + 1)]);
  const f = t - Math.floor(t);
  LUT.push([
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]);
}

export const rampCss = (t: number): string => {
  const [r, g, b] = LUT[Math.max(0, Math.min(255, Math.round(t * 255)))];
  return `rgb(${r},${g},${b})`;
};
