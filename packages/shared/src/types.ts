export type TeamId = 0 | 1;

/**
 * 1ティック分のプレイヤー入力。
 *
 * これがネットワークを流れる唯一の操作情報であり、AI もこの形でしか
 * 世界に干渉できない。AI と人間の性能を完全に同一にするための境界。
 */
export interface PlayerInput {
  /** 入力の連番。リコンシリエーションで使う。 */
  seq: number;
  /** 移動方向。長さは 0〜1（アナログスティックの倒し量）。 */
  moveX: number;
  moveY: number;
  /** キックの狙い。長さ1に正規化された方向ベクトル。 */
  aimX: number;
  aimY: number;
  /**
   * キックの強さの倍率（0〜1）。チャージ量に掛けて最終的な初速が決まる。
   *
   * スマホでは狙いを定めるのに指をドラッグする必要があり、その時間ぶん
   * チャージが溜まってしまう。つまり「丁寧に狙う」と「強く蹴る」が時間軸で
   * 結合していた。傾け度を独立した強さの軸にすることで、これを切り離す。
   *
   * マウス操作では狙いが一瞬で定まるためこの問題がなく、常に 1。
   */
  power: number;
  /** キックボタンを押しているか。押下中はチャージ、離した瞬間に発射。 */
  kick: boolean;
}

export function emptyInput(seq = 0): PlayerInput {
  return { seq, moveX: 0, moveY: 0, aimX: 1, aimY: 0, power: 1, kick: false };
}

export interface PlayerState {
  id: string;
  team: TeamId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 向き（描画とキック方向のフォールバックに使う）。 */
  facingX: number;
  facingY: number;
  /** チャージ経過秒。0 のときは非チャージ。 */
  charge: number;
  /** 前ティックでキックボタンが押されていたか。離した瞬間の検出用。 */
  kickHeld: boolean;
  /** 残りキッククールダウン秒。 */
  kickCooldown: number;
}

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface World {
  tick: number;
  players: PlayerState[];
  ball: BallState;
  score: [number, number];
}

/** step() が返す、そのティックで起きた出来事。描画・音・UI 側で使う。 */
export interface StepEvents {
  /** 得点したチーム。無得点なら null。 */
  goal: TeamId | null;
  /** このティックでキックしたプレイヤーの id と初速。 */
  kicks: { playerId: string; speed: number }[];
  /** ボールが壁に当たったか。 */
  wallHit: boolean;
}
