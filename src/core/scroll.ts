import type { ScrollPoint } from './types'

/**
 * ScrollModel —— 「可变化的下落时间」的全部实现。
 *
 * ============================ 为什么需要这个类 ============================
 *
 * 教科书式的下落公式是：
 *
 *     y = 判定线Y - (音符时间 - 当前时间) × 速度
 *
 * 这个公式**只在速度恒定时成立**。一旦允许下落时间随时间变化（也就是速度是
 * 时间的函数 speed(t)），就必须换成累积积分：
 *
 *     y = 判定线Y - ( S(音符时间) - S(当前时间) )
 *     其中 S(t) = ∫₀ᵗ speed(τ) dτ      ← 从歌曲开头到 t 这一刻，画面总共"滚过"了多少像素
 *
 * 直觉：音符的屏幕位置取决于「它和现在之间累积滚过的距离」，而不是「时间差 × 某个速度」。
 *
 * 这个模型有一个非常漂亮的性质：
 *     当 音符时间 == 当前时间 时，S(音符时间) - S(当前时间) = 0，音符正好落在判定线上，
 *     **无论中途速度怎么跳变都不受影响**。
 * 也就是说，视觉上的变速演出完全不会影响判定时刻（判定永远只由音符时间和音频时钟决定）。
 *
 * ============================ 实现上的处理 ============================
 *
 * S 是分段线性的，所以不必真的做积分，只要预先算好每个分段起点的 S 值（前缀和），
 * 之后任意时刻的 S 都是一次减法 + 一次乘法，O(log n) 查表即可。
 */
export class ScrollModel {
  /** 每个分段的起始时间（ms），升序 */
  private readonly times: Float64Array
  /** 每个分段的速度（px/ms），与 times 一一对应 */
  private readonly speeds: Float64Array
  /** prefix[i] = S(times[i])，即从第一个分段起点累积到 times[i] 的滚动距离 */
  private readonly prefix: Float64Array

  /**
   * @param points 分段点列表，**顺序无所谓**（内部会排序）。
   *               同一时间点出现多次时，数组中靠后的那个生效。
   */
  constructor(points: readonly ScrollPoint[]) {
    if (points.length === 0) {
      throw new Error('ScrollModel 至少需要一个分段点')
    }

    // Array.prototype.sort 从 ES2019 起保证是稳定排序，所以同一时间点的多个分段
    // 会保持原有相对顺序 —— 我们只要在后面按顺序覆盖，就自然实现了「后来者生效」。
    const sorted = points.slice().sort((a, b) => a.time - b.time)

    const times: number[] = []
    const speeds: number[] = []
    for (const point of sorted) {
      // 速度必须是非负有限数：
      //  - NaN / Infinity 会让累积距离变成 NaN，整个画面直接消失；
      //  - 负速度会让 S 不再单调，音符倒着飞，渲染的提前退出逻辑也会失效。
      //    （osu 里 SV 可以低到接近 0 表示"音符定住"，所以下界取 0 而不是某个正数。）
      const speed = Number.isFinite(point.speed) ? Math.max(0, point.speed) : 0

      if (times.length > 0 && times[times.length - 1] === point.time) {
        // 同一时刻重复出现 → 覆盖前一个
        speeds[speeds.length - 1] = speed
      } else {
        times.push(point.time)
        speeds.push(speed)
      }
    }

    const count = times.length
    const prefix = new Float64Array(count)
    // prefix[0] 固定为 0：S 是相对量，我们只关心两点之间的差值，绝对值无关紧要。
    for (let i = 1; i < count; i++) {
      prefix[i] = prefix[i - 1] + speeds[i - 1] * (times[i] - times[i - 1])
    }

    this.times = new Float64Array(times)
    this.speeds = new Float64Array(speeds)
    this.prefix = prefix
  }

  /**
   * 累积滚动距离 S(t)，单位像素。
   *
   * 注意 S 的零点是我们自己规定的（第一个分段点处为 0），
   * 所以单独看某个 S 值没有物理意义 —— 只有 `distance(b) - distance(a)` 才有意义。
   */
  distance(t: number): number {
    const i = this.segmentIndexAt(t)
    return this.prefix[i] + this.speeds[i] * (t - this.times[i])
  }

  /** 查询 t 这一刻的瞬时速度（px/ms），仅用于调试显示。 */
  speedAt(t: number): number {
    return this.speeds[this.segmentIndexAt(t)]
  }

  /** 分段数量，调试用。 */
  get segmentCount(): number {
    return this.times.length
  }

  /**
   * 找出「起始时间 <= t」的最后一个分段下标。
   *
   * t 早于第一个分段时返回 0 —— 这相当于用第一个分段的速度向前外推。
   * 这个行为是必要的：播放开始时会有一个提前量（见 SongClock），此时歌曲时间是负数。
   */
  private segmentIndexAt(t: number): number {
    const times = this.times
    if (t <= times[0]) return 0

    // 二分查找：满足 times[i] <= t 的最大 i
    let lo = 0
    let hi = times.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (times[mid] <= t) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    return lo
  }
}
