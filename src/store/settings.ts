import {
  DEFAULT_NOTE_SIZE_LEVEL,
  MAX_NOTE_SIZE_LEVEL,
  MAX_TILT_DEGREES,
  MIN_NOTE_SIZE_LEVEL,
  type NoteShape,
} from '../core/fall-style'
import { FALL_TIME_MAX, FALL_TIME_MIN } from '../core/engine'

/**
 * 设置的持久化（localStorage）。
 *
 * 刻意保持简单：所有设置都是原始类型或字符串数组，
 * 直接 JSON 序列化，不需要版本迁移框架。
 *
 * 但**读取时必须逐项校验**：用户可能手改过 localStorage、可能残留旧版本的数据、
 * 浏览器扩展也可能写坏它。一旦读进来的值不合预期（比如按键映射不是数组、
 * 下落时间是 NaN），整个游戏会以很难排查的方式崩掉。所以这里走一遍
 * "解析 → 校验 → 兜底"的流程，任何一项不合法就用默认值。
 */

const STORAGE_KEY = 'rhythm-4k/settings/v1'

/** 下落时间的可调范围。转发自引擎，避免"HTML 写死一份、这里又写死一份"慢慢跑偏。 */
export { FALL_TIME_MAX, FALL_TIME_MIN }

/** 设置项 */
export interface Settings {
  /**
   * 按键映射：codes[i] 是第 i 轨的 KeyboardEvent.code。
   *
   * 用 code 而不是 key，因为它表示物理按键位置 —— 切换输入法、
   * 打开大写锁定、换键盘布局都不会让绑定失效。
   */
  keyBindings: string[]
  /** 音符从顶部落到判定线所需的时间（ms） */
  fallTimeMs: number
  /**
   * 音频偏移（ms）。
   * 补偿音频输出延迟、以及部分音频文件（尤其 MP3 的编码器补零）带来的系统性偏移。
   * 结算页可以用本局的"平均偏差"一键修正。
   */
  audioOffsetMs: number
  /** 是否忽略谱面自带的 SV 变速（想要恒定下落手感时打开） */
  ignoreChartSv: boolean
  /**
   * 准备倒计时（ms）。
   * 谱面开始前先空出这么久，让玩家把手指放到键位上。0 表示不要倒计时。
   */
  countdownMs: number
  /** 按下轨道键时是否播放按键音 */
  keySoundEnabled: boolean
  /** 按键音音量，0..100 */
  keySoundVolume: number
  /**
   * 轨道倾斜角度（度）。0 = 垂直下落。
   *
   * 上限是 MAX_TILT_DEGREES(40)，但**实际生效的角度可能更小** ——
   * 轨道斜过去之后必须还留在画面里，窗口不够宽就会被自动削减。
   * 削减后的真实角度会显示在设置面板和 HUD 上。
   */
  tiltDegrees: number
  /** 音符形状：方形还是圆形 */
  noteShape: NoteShape
  /** 音符大小档位，1–5。3 是基准（也就是"没调过"的样子） */
  noteSizeLevel: number
  /**
   * 信息栏放在游玩区哪一侧。
   * 显示时外层容器会额外加宽，避免信息栏把轨道挤窄 —— 见 style.css。
   */
  infoPanelSide: InfoPanelSide
}

/** 信息栏位置 */
export type InfoPanelSide = 'left' | 'right' | 'off'

/** 准备倒计时的范围（ms）。0 = 关闭 */
export const COUNTDOWN_MIN = 0
export const COUNTDOWN_MAX = 10_000

/** 音频偏移允许的范围。超过这个范围说明是别的地方出了问题，不是延迟 */
export const AUDIO_OFFSET_LIMIT = 300

/** 各键数的默认按键映射。用物理位置相近、分属不同键盘矩阵行的键，减少无冲问题。 */
const DEFAULT_BINDINGS: Record<number, string[]> = {
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  5: ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
  6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
  7: ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
}

/** 4K 的默认键位，单独导出一份给 UI 做"恢复默认"用 */
export const DEFAULT_4K_BINDINGS: readonly string[] = DEFAULT_BINDINGS[4]

/** 取某个键数的默认映射。没有预设的键数就回退到 4K 的规则。 */
export function defaultBindingsFor(keyCount: number): string[] {
  const preset = DEFAULT_BINDINGS[keyCount]
  if (preset !== undefined) return [...preset]

  // 没预设的键数（8K 以上）：直接用主键盘数字行 1..N。
  // 不追求好用，只保证每一轨都有键可绑、不会静默失效。
  const fallback: string[] = []
  for (let lane = 0; lane < keyCount; lane++) {
    fallback.push(lane < 9 ? `Digit${lane + 1}` : '')
  }
  return fallback
}

/**
 * 取出某个键数下实际生效的按键映射。
 *
 * 设置里存的数组可能比当前谱面的键数短（先打了 4K 再打 7K），
 * 这时多出来的轨道用默认键补齐。
 */
export function bindingsFor(keyCount: number): string[] {
  const stored = loadSettings().keyBindings
  const fallback = defaultBindingsFor(keyCount)
  const result: string[] = []
  for (let lane = 0; lane < keyCount; lane++) {
    const code = stored[lane]
    result.push(typeof code === 'string' && code !== '' ? code : (fallback[lane] ?? ''))
  }
  return result
}

/** 读取设置。任何异常都会静默回退到默认值 —— 设置读不出来不该让游戏打不开。 */
export function loadSettings(): Settings {
  let parsed: unknown = null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw !== null) parsed = JSON.parse(raw)
  } catch {
    // localStorage 被禁用（隐私模式）、或者存的内容不是合法 JSON
    parsed = null
  }

  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >

  return {
    keyBindings: sanitizeBindings(record.keyBindings),
    fallTimeMs: clampNumber(record.fallTimeMs, FALL_TIME_MIN, FALL_TIME_MAX, 700),
    audioOffsetMs: clampNumber(
      record.audioOffsetMs,
      -AUDIO_OFFSET_LIMIT,
      AUDIO_OFFSET_LIMIT,
      0,
    ),
    ignoreChartSv: record.ignoreChartSv === true,
    countdownMs: clampNumber(record.countdownMs, COUNTDOWN_MIN, COUNTDOWN_MAX, 3000),
    // 默认开启；只有明确存了 false 才关掉（这样旧版本存的设置也会默认变成开启）
    keySoundEnabled: record.keySoundEnabled !== false,
    keySoundVolume: clampNumber(record.keySoundVolume, 0, 100, 70),
    tiltDegrees: clampNumber(record.tiltDegrees, 0, MAX_TILT_DEGREES, 0),
    // 只认 'circle'，其余（包括旧数据、被手改坏的值）一律回退到方形
    noteShape: record.noteShape === 'circle' ? 'circle' : 'square',
    noteSizeLevel: clampNumber(
      record.noteSizeLevel,
      MIN_NOTE_SIZE_LEVEL,
      MAX_NOTE_SIZE_LEVEL,
      DEFAULT_NOTE_SIZE_LEVEL,
    ),
    // 只认 'left' 和 'off'，其余一律回到默认的右侧
    infoPanelSide: sanitizeInfoPanelSide(record.infoPanelSide),
  }
}

/** 保存设置。写失败（配额满、隐私模式）不应该影响正在进行的游戏，所以吞掉异常。 */
export function saveSettings(next: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 忽略：设置存不下来不影响这一局能不能玩
  }
}

/** 读取当前设置、改一部分、写回去。UI 里最常用的写法。 */
export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  saveSettings(next)
  return next
}

// ---------------------------------------------------------------------------
// 校验辅助
// ---------------------------------------------------------------------------

/**
 * 校验按键映射数组。
 *
 * 这里只保证「每一项要么是合法的 code 字符串、要么是空串」，
 * 不处理重复键 —— 重复键的取舍交给 InputManager（先绑的生效），
 * 因为那里才知道当前谱面有几条轨道。
 */
function sanitizeBindings(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_4K_BINDINGS]
  const result: string[] = []
  for (const item of value) {
    result.push(typeof item === 'string' ? item : '')
  }
  // 空数组没有意义，会退化成"一首歌都打不了"
  return result.length > 0 ? result : [...DEFAULT_4K_BINDINGS]
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 校验信息栏位置。默认右侧 —— 大多数人习惯把辅助信息放在右边。 */
function sanitizeInfoPanelSide(value: unknown): InfoPanelSide {
  if (value === 'left') return 'left'
  if (value === 'off') return 'off'
  return 'right'
}
