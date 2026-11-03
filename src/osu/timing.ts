import type { OsuTimingPoint } from './parser'

/**
 * 把 osu 的 `[TimingPoints]` 折算成两组分段数据。
 *
 * osu 的 TimingPoints 里混着两种点，靠第 7 列 `uninherited` 区分：
 *
 *   ┌──────────────┬─────────────────────┬──────────────────────────────┐
 *   │ 类型         │ beatLength 的含义   │ 影响什么                     │
 *   ├──────────────┼─────────────────────┼──────────────────────────────┤
 *   │ BPM 点(红线) │ 每拍多少毫秒(正数)  │ 时间轴、谱面节奏             │
 *   │ SV 点(绿线)  │ 负数，换算成倍率    │ **只影响画面滚动速度**       │
 *   └──────────────┴─────────────────────┴──────────────────────────────┘
 *
 * 重要事实：**SV 完全不改变音符的时间，也不改变判定。**
 * 它只是让画面滚得快一点或慢一点。这正是这个项目"可变化下落时间"要复刻的东西。
 *
 * 第 1–3 步只用到 BPM 分段（显示用）；SV 分段在这里一并算好，
 * 第 5 步把它喂给 ScrollModel 就能生效。
 */

/** 一段 BPM。从 time 这一刻起，速度是 bpm。 */
export interface BpmSegment {
  time: number
  bpm: number
  /** 每拍毫秒数，留着方便后面做"按拍对齐"的功能 */
  beatLength: number
}

/** 一段 SV（滚动倍率）。从 time 这一刻起，倍率是 multiplier。 */
export interface SvSegment {
  time: number
  /** 1.0 = 原速。大于 1 更快，小于 1 更慢，0 = 音符定住 */
  multiplier: number
}

/** 导出所有 BPM 点形成的分段，同一时刻的重复点由靠后的那个生效。 */
export function deriveBpmSegments(points: readonly OsuTimingPoint[]): BpmSegment[] {
  const result: BpmSegment[] = []

  for (const point of byTime(points, true)) {
    const bpm = 60000 / point.beatLength
    if (!Number.isFinite(bpm) || bpm <= 0) continue

    const segment: BpmSegment = { time: point.time, bpm, beatLength: point.beatLength }
    // 同一时刻后来者覆盖
    if (result.length > 0 && result[result.length - 1].time === point.time) {
      result[result.length - 1] = segment
    } else {
      result.push(segment)
    }
  }

  return result
}

/** 导出所有 SV 点形成的分段，倍率已从 beatLength 换算好。 */
export function deriveSvSegments(points: readonly OsuTimingPoint[]): SvSegment[] {
  const result: SvSegment[] = []

  for (const point of byTime(points, false)) {
    // 继承点的 beatLength 是负数，换算公式是：
    //     multiplier = -100 / beatLength
    // 于是： -100 → 1.0x（原速）
    //        -50  → 2.0x
    //        -200 → 0.5x
    const multiplier = -100 / point.beatLength
    // 负倍率会让画面倒着滚，直接丢弃
    if (!Number.isFinite(multiplier) || multiplier < 0) continue

    const segment: SvSegment = { time: point.time, multiplier }
    if (result.length > 0 && result[result.length - 1].time === point.time) {
      result[result.length - 1] = segment
    } else {
      result.push(segment)
    }
  }

  return result
}

/**
 * 查询某个时刻的 BPM。仅用于 UI 显示。
 * BPM 分段的条数通常只有个位数到几十条，线性倒查足够快，不必二分。
 */
export function bpmAt(segments: readonly BpmSegment[], timeMs: number): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].time <= timeMs) return segments[i].bpm
  }
  // 第一个 BPM 点之前的时刻：osu 惯例是用第一个点的 BPM 向前外推
  return segments.length > 0 ? segments[0].bpm : 0
}

/** 按时间排序并筛选出 BPM 点或 SV 点。 */
function byTime(points: readonly OsuTimingPoint[], uninherited: boolean): OsuTimingPoint[] {
  return points.filter((point) => point.uninherited === uninherited).sort((a, b) => a.time - b.time)
}
