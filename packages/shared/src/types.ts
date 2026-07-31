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
  /**
   * GK を代わると宣言しているか。押している間ずっと true でよい。
   * すでに GK なら何も起きないので、押しっぱなしでも副作用はない。
   */
  claimGk: boolean;
}

export function emptyInput(seq = 0): PlayerInput {
  return {
    seq,
    moveX: 0,
    moveY: 0,
    aimX: 1,
    aimY: 0,
    power: 1,
    kick: false,
    claimGk: false,
  };
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
  /**
   * GK かどうか。各チームにちょうど1人。
   *
   * 能力は他の選手と完全に同一で、違いは**自陣ゴールエリアに入れる**ことだけ。
   * 出るのも自由。誰でもボタンで代われる。
   */
  isGk: boolean;
  /** AI が操作している席か。表示用で、挙動には影響しない。 */
  isAi: boolean;
}

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 試合の進行状態。 */
export type MatchPhase =
  /** 開始前・得点後の静止。位置がリセットされ、入力を受け付けない。 */
  | 'countdown'
  /** 通常プレー。 */
  | 'playing'
  /** ハーフタイム。コートチェンジを挟む。 */
  | 'halftime'
  /** 試合終了。しばらく結果を出してから次の試合へ。 */
  | 'finished';

/** 試合形式。部屋の作成時に決める。 */
export type MatchMode =
  /** 時間制。前後半それぞれ halfSeconds 秒。 */
  | 'time'
  /** 先取点制。先に targetScore 点取ったほうが勝ち。 */
  | 'firstTo';

export interface MatchConfig {
  mode: MatchMode;
  halfSeconds: number;
  targetScore: number;
}

export interface World {
  tick: number;
  players: PlayerState[];
  ball: BallState;
  score: [number, number];

  config: MatchConfig;
  phase: MatchPhase;
  /** 現在のフェーズの残り秒（playing 以外で使う）。 */
  phaseTimer: number;
  /** 前半なら 1、後半なら 2。先取点制では常に 1。 */
  half: 1 | 2;
  /** 時間制なら残り秒、先取点制なら経過秒。 */
  clock: number;
  /** 後半のコートチェンジ。true なら各チームの守るゴールが逆になる。 */
  sidesSwapped: boolean;

  /** 最後にボールに触れたチーム。ラインを割ったときの再開側の判定に使う。 */
  lastTouch: TeamId | null;
  /** ライン割れ後、ボールを保持する側のチーム。null なら通常プレー。 */
  restartTeam: TeamId | null;
  /** 上記の保持が続く残り秒。この間、相手チームはボールに触れない。 */
  restartTimer: number;
}

/** step() が返す、そのティックで起きた出来事。描画・音・UI 側で使う。 */
export interface StepEvents {
  /** 得点したチーム。無得点なら null。 */
  goal: TeamId | null;
  /** このティックでキックしたプレイヤーの id と初速。 */
  kicks: { playerId: string; speed: number }[];
  /** ボールが壁・ポストに当たったか。 */
  wallHit: boolean;
  /** ボールがラインを割ったか。 */
  outOfPlay: boolean;
  /** フェーズが変わったか。変わっていなければ null。 */
  phaseChanged: MatchPhase | null;
}

export function defaultMatchConfig(): MatchConfig {
  return { mode: 'time', halfSeconds: 180, targetScore: 5 };
}
