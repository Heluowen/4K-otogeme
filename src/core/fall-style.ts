/**
 * 下落样式：倾斜轨道（透视）+ 音符形状。
 *
 * 单独放一个文件，和 countdown.ts / celebration.ts 同理：
 *   1. 纯计算，不碰画布，放 core/ 才对得上分层；
 *   2. core/ 下除了类型不引任何运行时依赖，Node 能直接加载它做单元测试。
 *
 * ============================ 倾斜是什么 ============================
 *
 * 这里的"倾斜"是**垂直于视线方向的深度倾斜**：轨道像一条向远处延伸的路，
 * 判定线在脚下（离观察者最近），越往上越远、越窄、音符越小。
 *
 * 注意这和"整条轨道左右歪过去"是两回事 —— 那种做法会让轨道斜出画面，
 * 还得按窗口宽度削减角度。而透视倾斜是**向内收窄**的，永远不会溢出，
 * 所以 80° 也可以完整生效。
 *
 * ============================ 加速感从哪来 ============================
 *
 * 不需要额外写一条加速曲线 —— **透视本身就会产生加速感**。
 *
 * 音符沿着轨道是匀速滚动的（滚过多少像素由滚动模型决定），
 * 但投影到屏幕上之后，远处的位移被压得很小、近处被放得很大。
 * 结果就是：音符刚出现时在屏幕上慢慢挪，靠近判定线时突然快起来 ——
 * 这正是真实世界里"车从远处开过来"的观感。
 *
 * 而且这种加速是**几何自洽**的：它和轨道的收窄、音符的缩小来自同一个投影，
 * 三者在视觉上完全一致。这就是为什么这里不额外叠加一条加速曲线 ——
 * 叠上去反而会显得别扭。
 *
 * ============================ 与判定的关系 ============================
 *
 * 全部是**视觉**上的。判定只由音符时间和音频时钟决定，和投影毫无关系。
 * 但必须保证一个端点：音符时间等于当前时间时（depth = 0），
 * 它在屏幕上要精确落在判定线上 —— 见 screenRatio(strength, 0) === 1。
 */

/** 音符形状 */
export type NoteShape = 'square' | 'circle'

/** 单条轨道太窄就看不清，太宽则四轨之间距离过大、眼睛要来回扫 */
export const MIN_LANE_WIDTH = 110
export const MAX_LANE_WIDTH = 200

/**
 * 轨道区域占画布宽度的基准比例。
 * 这个比例直接决定「游玩区看起来有多大」—— 它是比轨宽上下限更主要的那个旋钮。
 */
const PLAYFIELD_WIDTH_RATIO = 0.72

/**
 * 轨道区域最多占画布的多少。
 *
 * 倾斜时判定线**以下**会向外张开（因为那里更靠近观察者）——
 * 80° 时底部比判定线处宽约 12%。留出这个余量，轨道才不会顶出画布。
 */
const PLAYFIELD_MAX_RATIO = 0.86

/**
 * 算出轨道区域的总宽（判定线处）。
 *
 * 优先级是：基准比例 → 轨宽上下限 → 画布硬上限。
 * 硬上限永远最高，因为它关系到"会不会画出界"。
 *
 * @param canvasWidth 画布宽（CSS 像素）
 * @param keyCount    键数
 */
export function computePlayfieldWidth(canvasWidth: number, keyCount: number): number {
  const width = Math.max(1, canvasWidth)
  const lanes = Math.max(1, Math.floor(keyCount))

  const preferred = width * PLAYFIELD_WIDTH_RATIO
  const minWidth = lanes * MIN_LANE_WIDTH
  // 硬上限和轨宽上限取较小者
  const maxWidth = Math.min(lanes * MAX_LANE_WIDTH, width * PLAYFIELD_MAX_RATIO)

  // ⚠️ minWidth 有可能大于 maxWidth（画布特别窄时）。
  // 这个写法保证那种情况下返回 **maxWidth**（也就是硬上限），而不是 minWidth ——
  // 否则轨道会溢出画布。顺序不能调换。
  return Math.min(maxWidth, Math.max(minWidth, preferred))
}

/**
 * 倾斜角度的上限（度）。
 *
 * 可以理解为"轨道平面与屏幕平面的夹角"：
 *   0°  → 轨道完全贴在屏幕上，没有任何纵深（= 原来的垂直下落）
 *   80° → 轨道几乎侧对着你，纵深被拉到极限
 *
 * 这里没有取到 90° 是因为 tan(90°) 是无穷大 —— 轨道彻底侧过去之后就"看不见"了。
 */
export const MAX_TILT_DEGREES = 80

/**
 * 把倾斜角度换算成透视强度。
 *
 * 用 tan 是因为它本来就是个"深度/横向"的比值 ——
 * 角度越大，同样一段距离对应的深度变化越剧烈，远处的收缩也就越强。
 */
export function tiltStrengthFromDegrees(degrees: number): number {
  return Math.tan(toRadians(clamp(degrees, 0, MAX_TILT_DEGREES)))
}

/**
 * 深度允许取到多负。
 *
 * ============================ 为什么必须夹 ============================
 *
 * 投影公式 `(1-u)/(1+ku)` 在 `u = -1/k` 处有一个**极点** —— 分母过零，
 * 算出来的屏幕坐标会炸到 1e18 这种量级。
 *
 * 那不是数学瑕疵，而是物理事实：那里是「轨道平面穿过摄像机所在平面」的位置。
 * 但对渲染来说后果非常严重：**只要一条路径里有一个这样的顶点，
 * Canvas 就会把整条路径都画不出来**。表现出来就是
 * 「长条音符按住一段时间之后整个消失」。
 *
 * 什么时候会撞上它：头部过线之后深度变负，`-1/k` 对应的时间是
 * `judgeLineY / (k · speed)`。倾斜 40°、下落时间 700ms 时大约是过线后 834ms。
 * 所以比这更长的长条都会中招 —— 短长条在极点到来之前就整条过线、被剔除掉了。
 *
 * ============================ 为什么是 -0.5/k ============================
 *
 * 在离极点还有一半的地方就夹住，是权衡的结果：
 *   - 夹住之后算出的 y 仍然远在画面下缘之外（会照常被剔除），剔除逻辑不受影响
 *   - 横向缩放同时最多放大到 2 倍，不会画出一个巨大的形状从遮罩下面透出来
 *   - 它只在 `u < 0`（判定线以下）生效，可见区域完全不受影响
 *   - 夹得再靠近极点（比如 -0.9/k）反而会让 y 更大，更危险
 *
 * k = 0（完全正交的垂直下落）根本没有极点，不夹。
 */
function minimumDepth(strength: number): number {
  return strength > 0 ? -0.5 / strength : Number.NEGATIVE_INFINITY
}

/** 把深度夹进安全范围。 */
function clampDepth(strength: number, depth: number): number {
  const minimum = minimumDepth(strength)
  return depth < minimum ? minimum : depth
}

/**
 * 给定归一化深度，算出透视缩放系数。
 *
 * @param strength 透视强度（由 tiltStrengthFromDegrees 得到）
 * @param depth    归一化深度：0 = 判定线（最近），1 = 一个下落距离之外（最远）
 * @returns 缩放系数。depth = 0 时恒为 1（不会有任何缩放，判定线处永远原尺寸）
 */
export function depthScale(strength: number, depth: number): number {
  if (!Number.isFinite(depth)) return 1
  // 夹住之后分母恒 >= 0.5，不可能再出现除零
  return 1 / (1 + strength * clampDepth(strength, depth))
}

/**
 * 给定归一化深度，算出它在屏幕上的竖直位置（占判定线高度的比例）。
 *
 * @returns 1 = 正好在判定线上，0 = 画面顶端的"最远处"
 *
 * 关键性质：`screenRatio(strength, 0)` 恒等于 1 ——
 * 也就是**不管倾斜多少度，音符时间一到它都精确落在判定线上**。
 * 这条性质是倾斜功能不影响判定的保证，单元测试专门盯着它。
 */
export function screenRatio(strength: number, depth: number): number {
  if (!Number.isFinite(depth)) return Number.MAX_SAFE_INTEGER
  const safe = clampDepth(strength, depth)
  return (1 - safe) / (1 + strength * safe)
}

/**
 * 反过来：已知屏幕上的 y，求该处的透视缩放系数。
 *
 * 画轨道（四边形）和分隔线（斜直线）时要用 ——
 * 因为缩放系数对 y 是**线性**的，轨道边缘在画面上就是直线，
 * 不需要按段逼近，两点一连即可。
 */
export function scaleAtScreenY(strength: number, judgeLineY: number, y: number): number {
  if (!Number.isFinite(y)) return 1
  const line = Math.max(1e-6, judgeLineY)
  return (line + y * strength) / (line * (1 + strength))
}

// ---------------------------------------------------------------------------
// 音符大小
// ---------------------------------------------------------------------------

/** 音符大小档位范围。基准档是 3。 */
export const MIN_NOTE_SIZE_LEVEL = 1
export const MAX_NOTE_SIZE_LEVEL = 5
export const DEFAULT_NOTE_SIZE_LEVEL = 3

/** 某一档的音符尺寸参数 */
export interface NoteSizePreset {
  /** 音符宽度占单条轨道的比例 */
  widthRatio: number
  /** 音符厚度相对基准档的倍率 */
  thicknessScale: number
}

/**
 * 五档音符大小。
 *
 * 第 3 档刻意取成**和改造前一模一样**的值：
 *   - `widthRatio: 0.84` 正好等于原来的「轨道宽度减去左右各 8% 的内边距」
 *   - `thicknessScale: 1` 就是原来的厚度
 * 这样加这个设置不会改变任何人现有的观感，第 3 档就是"没调过"的样子。
 *
 * 宽度封顶在 1.0 —— 音符画得比轨道还宽会溢到隔壁轨道上去，那看着就坏了。
 * 所以最大档的宽度正好占满轨道，再大的差异只能靠厚度体现。
 */
const NOTE_SIZE_PRESETS: readonly NoteSizePreset[] = [
  { widthRatio: 0.6, thicknessScale: 0.55 }, // 1 最小
  { widthRatio: 0.72, thicknessScale: 0.75 }, // 2 较小
  { widthRatio: 0.84, thicknessScale: 1 }, // 3 基准
  { widthRatio: 0.93, thicknessScale: 1.3 }, // 4 较大
  { widthRatio: 1, thicknessScale: 1.65 }, // 5 最大
]

/**
 * 取某一档的音符尺寸参数。
 * 档位超出 [1, 5] 会被夹住；NaN 之类的非法值回到基准档。
 */
export function noteSizePreset(level: number): NoteSizePreset {
  if (!Number.isFinite(level)) return NOTE_SIZE_PRESETS[DEFAULT_NOTE_SIZE_LEVEL - 1]
  const index = Math.round(clamp(level, MIN_NOTE_SIZE_LEVEL, MAX_NOTE_SIZE_LEVEL)) - 1
  return NOTE_SIZE_PRESETS[index]
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}
