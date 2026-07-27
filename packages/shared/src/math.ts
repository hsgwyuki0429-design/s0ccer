export interface Vec2 {
  x: number;
  y: number;
}

export function length(x: number, y: number): number {
  return Math.hypot(x, y);
}

/** ベクトルを長さ1に正規化する。零ベクトルはそのまま返す。 */
export function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (len < 1e-9) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

/** 長さが max を超える場合だけ max に切り詰める。 */
export function clampLength(v: Vec2, max: number): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (len <= max || len < 1e-9) return { x: v.x, y: v.y };
  const s = max / len;
  return { x: v.x * s, y: v.y * s };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
