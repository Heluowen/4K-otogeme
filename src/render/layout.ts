import { computePlayfieldWidth, scaleAtScreenY, tiltStrengthFromDegrees } from '../core/fall-style'

/**
 * 轨道几何计算。
 *
 * 把所有"画面尺寸相关的换算"集中在这里，好处是引擎其余部分只用抽象量：
 * 「判定线在 y 多少」「一轨多宽」「倾斜多少」。将来要改布局（比如判定线位置可调、
 * 支持 7K 的居中分隔）只需要动这个文件。
 */

export interface Layout {
  /** 画布宽（CSS 像素，不是物理像素） */
  width: number
  /** 画布高（CSS 像素） */
  height: number
  keyCount: number
  /** 轨道区域左边缘的 x（这是**判定线处**的边缘，越往上会向中心收窄） */
  playfieldLeft: number
  /** 轨道区域总宽（同样是判定线处的宽度） */
  playfieldWidth: number
  /** 单条轨道的宽度（判定线处） */
  laneWidth: number
  /**
   * 判定线的 y 坐标。
   *
   * 它同时也是「音符的下落距离」：音符从最远处滚 judgeLineY 像素后到达判定线。
   * 于是在恒定速度下，速度 = judgeLineY / 下落时间。
   */
  judgeLineY: number
  /** 透视强度 = tan(倾斜角)。0 表示完全正交，也就是原来的垂直下落 */
  tiltStrength: number
  /** 倾斜角度（度），就是设置里那个值 */
  tiltDegrees: number
  /**
   * 透视收缩的中心 x（消失点所在的竖直方向）。
   * 轨道越往上越向这条线收窄。
   */
  vanishX: number
}

/** 判定线放在画面高度的这个比例处。留一点下方空间，视觉上不会顶到底。 */
const JUDGE_LINE_RATIO = 0.88

/**
 * 根据画布尺寸、键数和倾斜角度算出布局。
 *
 * @param width                画布宽（CSS 像素）
 * @param height               画布高（CSS 像素）
 * @param requestedTiltDegrees 倾斜角度（度），0 表示垂直下落
 */
export function computeLayout(
  width: number,
  height: number,
  keyCount: number,
  requestedTiltDegrees = 0,
): Layout {
  // 轨道区域宽度：基准是画布宽度的一个比例，再用轨宽上下限和画布硬上限夹住。
  // 具体规则和"倾斜时底部会张开"这个约束都在 core/fall-style.ts 里，那里有单元测试。
  const playfieldWidth = computePlayfieldWidth(width, keyCount)
  const laneWidth = playfieldWidth / keyCount
  const playfieldLeft = (width - playfieldWidth) / 2
  const judgeLineY = Math.max(60, height * JUDGE_LINE_RATIO)

  return {
    width,
    height,
    keyCount,
    playfieldLeft,
    playfieldWidth,
    laneWidth,
    judgeLineY,
    tiltStrength: tiltStrengthFromDegrees(requestedTiltDegrees),
    tiltDegrees: requestedTiltDegrees,
    vanishX: playfieldLeft + playfieldWidth / 2,
  }
}

/**
 * 屏幕上某个 y 处的透视缩放系数。
 *
 * y = judgeLineY 处恒为 1；越往上（y 越小）越小，轨道越窄、音符越小。
 * 判定线**以下**会大于 1（更靠近观察者，所以更宽）—— 这一点是正确透视的一部分。
 */
export function perspectiveScaleAt(layout: Layout, y: number): number {
  return scaleAtScreenY(layout.tiltStrength, layout.judgeLineY, y)
}

/**
 * 把「判定线处的某个 x」投影到屏幕上一行 y 处的实际 x。
 *
 * 所有的横向收缩都朝 vanishX 进行。倾斜为 0 时缩放系数恒为 1，
 * 这个函数退化成直接返回 laneX —— 也就是原来的垂直下落，行为完全不变。
 */
export function projectLaneX(layout: Layout, laneX: number, y: number): number {
  const scale = perspectiveScaleAt(layout, y)
  return layout.vanishX + (laneX - layout.vanishX) * scale
}
