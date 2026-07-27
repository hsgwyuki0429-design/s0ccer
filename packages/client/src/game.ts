import type { TeamId, World } from '@s0ccer/shared';

/**
 * ゲームモードの共通インターフェース。
 *
 * オフライン（ローカル単独）とオンライン（サーバー権威 + 予測）を
 * 同じ形で扱えるようにして、描画とループを共有する。
 */
export interface Game {
  /** 描画に使う世界。オンラインでは予測結果に誤差平滑を足したもの。 */
  readonly world: World;
  /** 自分の選手の id。まだ確定していなければ空文字。 */
  readonly localId: string;
  /** 現在の狙いの向き。 */
  readonly aimDir: { x: number; y: number };

  onGoal: ((team: TeamId) => void) | null;

  update(frameDt: number): void;
  /** HUD 左上に出すデバッグ行。 */
  debugLines(): string[];
  /** 接続状態などの一行表示。 */
  statusText(): string;
  /** ローカルモードのみ有効。オンラインではサーバーが権威なので何もしない。 */
  reset(): void;
}

/** 自分の選手の画面座標を返す関数。マウス操作の狙いの起点に使う。 */
export type ScreenOf = (x: number, y: number) => { x: number; y: number };
