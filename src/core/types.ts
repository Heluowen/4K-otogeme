/**
 * 引擎内部统一的数据结构。
 *
 * 设计原则：**核心引擎不认识 osu**。
 * osu 的 BPM、SV、小节、CircleSize 这些东西全部在解析阶段折算成这里的最简形式：
 * 「第几轨 + 第几毫秒」。这样以后要接 Malody / Quaver / BMS，只需要再写一个
 * 解析器产出同样的 Chart，判定和渲染代码一行都不用改。
 */

/** 一条音符。所有时间都是「相对音频文件开头的毫秒数」。 */
export interface Note {
  /** 轨道号，从 0 开始。4K 时取值 0..3 */
  column: number
  /** 音符到达判定线的时间（ms） */
  time: number
  /**
   * 长条的结束时间（ms）。
   * 单点音符这里等于 time —— 用「是否相等」来判断是不是长条，
   * 比额外加一个 isHold 布尔字段更难写出不一致的状态。
   */
  endTime: number
}

/** 谱面元信息，主要用于 UI 显示，以及第 4 步计算判定窗口。 */
export interface ChartMeta {
  title: string
  artist: string
  creator: string
  /** 难度名，即 osu 的 [Metadata] Version */
  version: string
  /** 音频在压缩包里的文件名（来自 [General] AudioFilename） */
  audioFilename: string
  /** osu 的 [Difficulty] OverallDifficulty，第 4 步用它推导判定窗口 */
  overallDifficulty: number
}

/** 一张可直接交给引擎播放的谱面。 */
export interface Chart {
  meta: ChartMeta
  /** 键数（4K 就是 4）。引擎对任意键数都成立，UI 层再做限制 */
  keyCount: number
  /** 音符列表，**必须按 time 升序排列** —— 渲染时的提前退出依赖这个顺序 */
  notes: Note[]
  /**
   * 谱面自带的滚动倍率变化点（osu 里就是 [TimingPoints] 的绿线，也就是 SV），
   * 按 time 升序。没有变速就是空数组。
   *
   * 核心只认识「倍率」这个概念，不知道 osu 那套 beatLength 为负数的约定 ——
   * 那层换算在 osu/timing.ts 里就做完了。
   *
   * 倍率作用在画面滚动的速度上，**完全不影响音符的时间，也不影响判定**。
   * 这正是积分滚动模型存在的意义（见 core/scroll.ts）。
   */
  speedPoints: SpeedMultiplierPoint[]
}

/** 一个滚动倍率变化点。 */
export interface SpeedMultiplierPoint {
  /** 从这一刻起生效（ms） */
  time: number
  /** 1.0 = 原速。大于 1 更快，小于 1 更慢，0 表示音符定在原地 */
  multiplier: number
}

/**
 * 滚动模型的一个分段点：从 time 这一刻起，滚动速度为 speed（像素/毫秒）。
 *
 * 第 1–3 步只会用到「恒定速度」这一个分段；第 5 步接入 osu 的 SV 时，
 * 就是把谱面里的每个 SV 点换算成 speed 塞进这个数组，其余代码完全不动。
 */
export interface ScrollPoint {
  /** 这个分段从哪一刻开始生效（ms） */
  time: number
  /** 该分段的滚动速度，单位 px/ms */
  speed: number
}
