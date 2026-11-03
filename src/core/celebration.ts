/**
 * 全连击庆祝动画的时间曲线。
 *
 * 单独放一个文件，理由和 countdown.ts 一样：
 *   1. 它是纯计算，不碰画布，放在 core/ 才对得上分层；
 *   2. core/ 下的模块除了类型不引入任何运行时依赖，Node 能直接加载它做单元测试
 *      （render/canvas.ts 里有未写扩展名的 import，Node 的 ESM 加载器解析不了）。
 *
 * 时间曲线最容易写错的地方是"什么时候该出现、什么时候该消失"这类边界，
 * 所以这些边界值都被单元测试钉死了。
 */

/** 整个庆祝动画持续多久（ms） */
export const FULL_COMBO_DURATION_MS = 2600

/** 入场放大阶段 */
const INTRO_MS = 340
/** 收尾淡出阶段 */
const OUTRO_MS = 620
/** 开场全屏闪光 */
const FLASH_MS = 170
/** 横幅展开 */
const BAND_MS = 420

/** 某一时刻的动画状态 */
export interface CelebrationFrame {
  /** 是否应该绘制 */
  visible: boolean
  /** 文字缩放倍率 */
  scale: number
  /** 整体透明度 0..1 */
  alpha: number
  /** 横幅展开进度 0..1 */
  bandProgress: number
  /** 全屏闪光强度 0..1 */
  flash: number
}

/** 不在动画时间窗内时返回的常量对象（复用同一个，避免每帧新建） */
const HIDDEN: CelebrationFrame = {
  visible: false,
  scale: 1,
  alpha: 0,
  bandProgress: 1,
  flash: 0,
}

/**
 * 根据"已经过去多久"算出这一帧该怎么画。
 *
 * @param elapsedMs 距离达成全连击那一刻过去了多少毫秒。
 *                  负数（还没达成）和超出动画时长都会返回 visible: false。
 */
export function fullComboAnimation(elapsedMs: number): CelebrationFrame {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > FULL_COMBO_DURATION_MS) {
    return HIDDEN
  }

  const intro = Math.min(1, elapsedMs / INTRO_MS)
  // 收尾阶段的进度：0 = 还没开始淡出，1 = 已经完全消失
  const outro = Math.max(0, (elapsedMs - (FULL_COMBO_DURATION_MS - OUTRO_MS)) / OUTRO_MS)

  // 带回弹的放大：先冲过头一点点，再收回来。
  // 线性放大看着很"廉价"，有回弹才有"砰"地弹出来的感觉。
  const scale = (0.35 + 0.65 * easeOutBack(intro)) * (1 + 0.06 * outro)

  // 极快地淡入（90ms 内完成），避免真的"闪"出来吓一跳；收尾时淡出
  const alpha = Math.min(1, elapsedMs / 90) * (1 - outro)

  const bandProgress = easeOutCubic(Math.min(1, elapsedMs / BAND_MS))
  const flash = Math.max(0, 1 - elapsedMs / FLASH_MS)

  return { visible: true, scale, alpha, bandProgress, flash }
}

/**
 * 回弹缓动：0 → 1，中途会略微冲过 1 再落回来。
 * 这是 CSS 里 `cubic-bezier` 那个 back 缓动的标准公式。
 */
function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  const p = t - 1
  return 1 + c3 * p * p * p + c1 * p * p
}

/** 三次缓出：起步快、收尾慢 */
function easeOutCubic(t: number): number {
  const p = 1 - t
  return 1 - p * p * p
}
