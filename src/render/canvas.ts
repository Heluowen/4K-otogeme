import { fullComboAnimation } from '../core/celebration'
import { countdownTick } from '../core/countdown'
import { depthScale, noteSizePreset, screenRatio, type NoteShape } from '../core/fall-style'
import {
  Grade,
  GRADE_COLORS,
  GRADE_LABELS,
  NOTE_RESOLVED,
  type HitFeedback,
  type JudgeStats,
} from '../core/judge'
import type { Chart } from '../core/types'
import { projectLaneX, type Layout } from './layout'

/**
 * Canvas 绘制层。
 *
 * 这个模块是**纯函数**：给它一帧的数据，它把画面画出来，不持有任何状态、不读时钟。
 * 好处是渲染和游戏逻辑彻底解耦 —— 想换成 WebGL/PixiJS 时，只要再写一个同签名的
 * 函数替换掉这个文件即可，引擎完全不用改。
 *
 * 坐标约定：
 *   - 所有坐标都是 CSS 像素（画布已按 devicePixelRatio 做过缩放，见 Engine.resize）
 *   - y 轴向下为正
 *   - 时间越晚的音符，y 越小（位置越高），所以长条的"尾巴"在"头"的上面
 *
 * ============================ 倾斜轨道（透视） ============================
 *
 * 倾斜是**垂直于视线方向的深度倾斜**：判定线在最近处（画面下方），
 * 越往上越远。所有的横向位置都朝消失点 `vanishX` 按缩放系数收缩，
 * 音符也按同一个系数缩小。
 *
 * 因为 x 和 y 都是缩放系数的**线性**函数，而缩放系数又是 y 的线性函数，
 * 所以一条轨道的两条边在屏幕上就是**直线** —— 轨道是个梯形，
 * 不需要按段逼近，两个端点一连即可。
 *
 * 判定线本身始终保持水平、宽度不变（缩放系数在 y = judgeLineY 处恒为 1）。
 * 这是必须的：音符时间一到就要精确落在判定线上，判定线本身不能参与透视。
 */
/** 屏幕外多留这么多像素才剔除音符。留余量是为了避免音符在边缘"啪"地凭空出现 */
const CULL_MARGIN = 80

const COLOR_BG = '#0d0d14'
const COLOR_LANE_EVEN = '#12121a'
const COLOR_LANE_ODD = '#17171f'
const COLOR_SEPARATOR = '#252533'
const COLOR_JUDGE_LINE = '#e8e8f0'
/** 判定线以下的遮罩，让已经过线的音符自然淡下去 */
const COLOR_VIEW_COVER = 'rgba(8, 8, 12, 0.82)'
const COLOR_TEXT = '#e8e8f0'
const COLOR_TEXT_DIM = '#8a8aa0'

/** FAST / LATE 提示的配色。冷色 = 打早，暖色 = 打晚，和多数音游的习惯一致。 */
const COLOR_TIMING_FAST = '#6cc7ff'
const COLOR_TIMING_LATE = '#ff9a5c'

/** 全连击庆祝的配色。金色系，和判定色区分得开。 */
const FC_TEXT_COLOR = '#fff6d6'
const FC_TEXT_GLOW = 'rgba(255, 210, 77, 0.95)'
const FC_BAND_COLOR = '#ffd24d'
const FC_EDGE_COLOR = '#fff3cf'

/** 轨道配色。键数超过配色数量时会循环取用 */
const LANE_COLORS = ['#4da3ff', '#ffd24d', '#ff6b8a', '#7ad9a0', '#c08cff', '#69e0e0', '#ff9a5c']

/** 判定飘字在画面上存活多久（ms），要和 judge.ts 里的 FEEDBACK_LIFETIME_MS 对齐 */
const FEEDBACK_LIFETIME_MS = 600

/** 渲染一帧所需的所有数据。 */
export interface RenderInput {
  chart: Chart
  layout: Layout
  /** headDist[i] = S(notes[i].time)，音符头部的累积滚动距离（px） */
  headDist: Float64Array
  /** tailDist[i] = S(notes[i].endTime)，音符尾部的累积滚动距离（px） */
  tailDist: Float64Array
  /** S(当前歌曲时间)，即"画面此刻总共滚过了多少像素" */
  scrollDistanceNow: number
  /** 是否正在播放。暂停时整个画面压暗，给一个明确的视觉反馈 */
  playing: boolean
  /** 当前歌曲时间（ms），判定飘字淡出要用。倒计时期间会比实际播放位置更早 */
  songTimeMs: number
  /**
   * 倒计时还剩多久（ms）。0 表示当前没有倒计时。
   *
   * 用「还剩多久」而不是一个布尔标志，是因为倒计时的终点不一定是歌曲 0ms ——
   * 暂停恢复时是从暂停位置往回倒带的。
   */
  countdownRemainingMs: number
  /** 倒计时总时长（ms），画进度条要用 */
  countdownTotalMs: number
  /**
   * 每个音符的运行时状态（下标与 chart.notes 一致）。
   *
   * 渲染层用它跳过**已经判完**的音符。平时看不出来（判定线以下被遮罩盖住），
   * 但暂停恢复会有一段倒带，不跳过的话已经打过的音符会重新落一遍，像在重打。
   */
  noteStates: Uint8Array
  /** 达成全连击的时刻（歌曲时间 ms）；-1 表示还没达成 */
  fullComboAtMs: number
  /** 音符形状：方形还是圆形 */
  noteShape: NoteShape
  /** 音符大小档位，1–5。3 是基准 */
  noteSizeLevel: number
  /** 每条轨道此刻是否被按住 */
  laneDown: readonly boolean[]
  /** 最近一小段时间内的判定记录 */
  feedbacks: readonly HitFeedback[]
  /** 判定统计（连击、准确率、分数……） */
  stats: JudgeStats
}

/** 画一帧。 */
export function renderFrame(g: CanvasRenderingContext2D, input: RenderInput): void {
  const { chart, layout, headDist, tailDist, scrollDistanceNow, playing } = input
  const { width, height, keyCount, playfieldLeft, playfieldWidth, laneWidth, judgeLineY } = layout

  // ① 清屏
  g.fillStyle = COLOR_BG
  g.fillRect(0, 0, width, height)

  // ② 轨道底色。奇偶轨交替深浅，一眼就能数清是第几轨。
  //    倾斜时轨道是梯形，所以不能再用 fillRect，得走路径。
  for (let column = 0; column < keyCount; column++) {
    g.fillStyle = column % 2 === 0 ? COLOR_LANE_EVEN : COLOR_LANE_ODD
    lanePath(g, layout, column, 0, height)
    g.fill()
  }

  // ③ 按键高亮：哪一轨按着就整条亮一点，给出最直接的输入反馈
  for (let column = 0; column < keyCount; column++) {
    if (input.laneDown[column] !== true) continue
    g.fillStyle = withAlpha(LANE_COLORS[column % LANE_COLORS.length], 0.13)
    lanePath(g, layout, column, 0, height)
    g.fill()
  }

  // ④ COMBO 数字。
  // 刻意画在音符**下面**，这样再大的数字也不会挡住谱面 —— 挡谱是音游大忌。
  drawCombo(g, input)

  // ⑤ 音符层。裁剪范围要同时罩住轨道的上窄下宽两端，
  //    否则画面底部那一小截（透视上更靠近观察者、更宽）会被切掉。
  const bottomLeft = projectLaneX(layout, playfieldLeft, height)
  const bottomRight = projectLaneX(layout, playfieldLeft + playfieldWidth, height)
  const clipLeft = Math.min(playfieldLeft, bottomLeft)
  const clipRight = Math.max(playfieldLeft + playfieldWidth, bottomRight)

  g.save()
  g.beginPath()
  g.rect(clipLeft, 0, clipRight - clipLeft, height)
  g.clip()
  drawNotes(
    g,
    chart,
    layout,
    headDist,
    tailDist,
    scrollDistanceNow,
    input.noteShape,
    input.noteSizeLevel,
    input.noteStates,
  )
  g.restore()

  // ⑥ 判定线以下的遮罩。盖在音符之上，产生"过线即淡出"的效果。
  //    它也得跟着透视走 —— 判定线以下轨道是向外张开的，用矩形会盖不住。
  g.beginPath()
  g.moveTo(projectLaneX(layout, playfieldLeft, judgeLineY), judgeLineY)
  g.lineTo(projectLaneX(layout, playfieldLeft + playfieldWidth, judgeLineY), judgeLineY)
  g.lineTo(bottomRight, height)
  g.lineTo(bottomLeft, height)
  g.closePath()
  g.fillStyle = COLOR_VIEW_COVER
  g.fill()

  // ⑦ 轨道分隔线。透视下它们是一组朝消失点汇聚的直线。
  g.strokeStyle = COLOR_SEPARATOR
  g.lineWidth = 1
  for (let column = 0; column <= keyCount; column++) {
    const laneX = playfieldLeft + column * laneWidth
    g.beginPath()
    g.moveTo(projectLaneX(layout, laneX, 0), 0)
    g.lineTo(projectLaneX(layout, laneX, height), height)
    g.stroke()
  }

  // ⑧ 判定线。始终水平且宽度不变 —— 音符最终要落在它上面，
  //    它一旦参与透视，"音符压线"这件事就没法一眼判读了。
  g.fillStyle = COLOR_JUDGE_LINE
  g.fillRect(playfieldLeft, judgeLineY - 1.5, playfieldWidth, 3)

  // ⑨ 判定结果 + ⑩ 计分板 + ⑪ 准备倒计时 + ⑫ 全连击庆祝
  drawJudgement(g, input)
  drawScoreboard(g, input)
  drawCountdown(g, input)
  drawFullCombo(g, input)

  // ⑬ 暂停提示
  if (!playing) {
    g.fillStyle = 'rgba(255, 255, 255, 0.55)'
    g.font = '600 15px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('已暂停', width / 2, judgeLineY * 0.45)
  }
}

// ---------------------------------------------------------------------------
// 轨道几何
// ---------------------------------------------------------------------------

/**
 * 把一条轨道从 top 到 bottom 的四边形路径加到当前路径上（不填充）。
 *
 * 判定线处轨道占 `[left, left + laneWidth]`；越往上越向 vanishX 收窄。
 * 因为横向位置和 y 之间是线性关系，四条边围出来的是一个**梯形**，
 * 四个端点直接连线就是精确结果，不需要拆成小段。
 */
function lanePath(
  g: CanvasRenderingContext2D,
  layout: Layout,
  column: number,
  top: number,
  bottom: number,
): void {
  const left = layout.playfieldLeft + column * layout.laneWidth
  const right = left + layout.laneWidth

  g.beginPath()
  g.moveTo(projectLaneX(layout, left, top), top)
  g.lineTo(projectLaneX(layout, right, top), top)
  g.lineTo(projectLaneX(layout, right, bottom), bottom)
  g.lineTo(projectLaneX(layout, left, bottom), bottom)
  g.closePath()
}

// ---------------------------------------------------------------------------
// 音符
// ---------------------------------------------------------------------------

/** 画所有音符。 */
function drawNotes(
  g: CanvasRenderingContext2D,
  chart: Chart,
  layout: Layout,
  headDist: Float64Array,
  tailDist: Float64Array,
  scrollDistanceNow: number,
  shape: NoteShape,
  sizeLevel: number,
  noteStates: Uint8Array,
): void {
  const { height, judgeLineY, laneWidth, vanishX, tiltStrength, playfieldLeft } = layout
  const notes = chart.notes

  // 音符尺寸都按轨宽成比例，换分辨率/键数时观感一致。
  // 这些是**判定线处**的尺寸（缩放系数为 1），越远会按比例缩小。
  const preset = noteSizePreset(sizeLevel)

  // 用「内边距」而不是直接拿比例去乘，是为了保住一个最小留白 ——
  // 轨道特别窄的时候音符依然不会贴到分隔线上。
  // 第 3 档的 (1 - 0.84) / 2 = 0.08 正好是原来的内边距，所以基准档外观完全不变。
  const inset = Math.max(1, (laneWidth * (1 - preset.widthRatio)) / 2)
  const baseNoteWidth = laneWidth - inset * 2
  const baseNoteHeight = Math.max(10, Math.min(20, laneWidth * 0.17)) * preset.thicknessScale
  const baseTailHeight = Math.max(3, baseNoteHeight * 0.55)
  // 长条主体比音符窄一些，比例沿用原来的 0.56 / 0.84 = 2/3
  const baseBodyWidth = baseNoteWidth * (2 / 3)
  // 圆形音符如果只有方块那么高会小得看不清，所以单独给它一个更大的直径
  const baseCircleDiameter = Math.min(
    baseNoteWidth,
    laneWidth * 0.32 * preset.thicknessScale,
  )

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]

    // 到判定线还有多少像素
    const headDistance = headDist[i] - scrollDistanceNow
    const tailDistance = tailDist[i] - scrollDistanceNow

    // 归一化深度：0 = 判定线，1 = 一个下落距离之外
    const headDepth = headDistance / judgeLineY
    const headY = judgeLineY * screenRatio(tiltStrength, headDepth)

    // 提前退出：screenRatio 对深度是严格单调递减的，而后面的音符深度只会更大，
    // 所以一旦某个音符已经跑到画面上方之外，后面的就都不用画了。
    if (headY < -CULL_MARGIN) break

    // 已经判完的音符不再绘制。
    //
    // 顺序上必须放在 break 判断**之后** —— break 依赖 headY 的单调性，
    // 提前 continue 会让循环永远退不出去。
    //
    // 平时其实看不出区别（判定线以下都被遮罩盖住了），但暂停恢复时画面会倒带
    // 几秒，不跳过的话已经打过的音符会重新落一遍，看起来像在重打。
    // 顺带也让中途断掉的长条立刻消失，而不是继续慢悠悠落下去。
    if (noteStates[i] === NOTE_RESOLVED) continue

    const tailDepth = tailDistance / judgeLineY
    const tailY = judgeLineY * screenRatio(tiltStrength, tailDepth)
    // 一个音符在屏幕上的竖直范围是 [tailY, headY]（tail 在上）。
    // 最靠上的点都跑到屏幕下缘之外了就整个看不见。
    if (Math.min(headY, tailY) > height + CULL_MARGIN) continue

    // 透视缩放。尾部比头部更远，所以尾部更小 —— 长条因此"上细下粗"，
    // 这正是真实透视该有的样子。
    const headScale = depthScale(tiltStrength, headDepth)
    const tailScale = depthScale(tiltStrength, tailDepth)

    const laneCenterX = playfieldLeft + (note.column + 0.5) * laneWidth
    const headX = vanishX + (laneCenterX - vanishX) * headScale
    const tailX = vanishX + (laneCenterX - vanishX) * tailScale

    const color = LANE_COLORS[note.column % LANE_COLORS.length]

    if (note.endTime > note.time) {
      // 长条主体：头尾处在两个不同的深度上，缩放系数不同，
      // 所以它是个**梯形**而不是矩形。
      const bodyHalfHead = (baseBodyWidth * headScale) / 2
      const bodyHalfTail = (baseBodyWidth * tailScale) / 2

      g.fillStyle = withAlpha(color, 0.4)
      g.beginPath()
      g.moveTo(tailX - bodyHalfTail, tailY)
      g.lineTo(tailX + bodyHalfTail, tailY)
      g.lineTo(headX + bodyHalfHead, headY)
      g.lineTo(headX - bodyHalfHead, headY)
      g.closePath()
      g.fill()

      // 尾端：一个较亮的短块，标出松手的时机
      const tailWidth = baseNoteWidth * tailScale
      const tailBlockHeight = Math.max(3, baseTailHeight * tailScale)
      g.fillStyle = withAlpha(color, 0.72)
      g.fillRect(tailX - tailWidth / 2, tailY - tailBlockHeight / 2, tailWidth, tailBlockHeight)
    }

    // 头端。它的**最底端**落在 headY 上，所以音符时间一到它就精确压在判定线上。
    const blockWidth = baseNoteWidth * headScale
    const blockHeight = (shape === 'circle' ? baseCircleDiameter : baseNoteHeight) * headScale
    drawNoteBlock(g, headX - blockWidth / 2, headY - blockHeight, blockWidth, blockHeight, shape, color)
  }
}

/**
 * 画一个音符块。
 *
 * 两种形状都保证「最底端落在 y + height 上」——
 * 这样方变圆之后判定线位置看起来完全一致，不会觉得手感变了。
 */
function drawNoteBlock(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  shape: NoteShape,
  color: string,
): void {
  g.fillStyle = color

  if (shape === 'circle') {
    // 内切圆：直径取宽高里较小的那个。
    // 圆心放在底边上方一个半径处，保证圆的**最底端**正好落在 y + height。
    const radius = Math.min(width, height) / 2
    if (radius <= 0.2) return
    g.beginPath()
    g.arc(x + width / 2, y + height - radius, radius, 0, Math.PI * 2)
    g.fill()
    return
  }

  g.fillRect(x, y, width, height)
}

// ---------------------------------------------------------------------------
// 判定反馈
// ---------------------------------------------------------------------------

/**
 * 判定提示的几何位置。
 *
 * 连击数字、判定结果、FAST/LATE 三行竖着排在轨道中间，
 * 位置全都从这里算，免得几处各写一份慢慢对不齐。
 */
interface JudgementLayout {
  centerX: number
  comboSize: number
  comboCenterY: number
  gradeSize: number
  gradeY: number
  timingSize: number
  timingY: number
}

function judgementLayout(layout: Layout): JudgementLayout {
  const { judgeLineY, playfieldLeft, playfieldWidth } = layout

  const comboSize = Math.max(24, Math.min(playfieldWidth * 0.24, 68))
  const comboCenterY = judgeLineY * 0.42

  const gradeSize = Math.max(15, Math.min(playfieldWidth * 0.085, 30))
  // 判定结果紧贴在连击数字下方
  const gradeY = comboCenterY + comboSize * 0.5 + gradeSize * 0.85

  const timingSize = Math.max(10, gradeSize * 0.5)
  const timingY = gradeY + gradeSize * 0.85

  return {
    centerX: playfieldLeft + playfieldWidth / 2,
    comboSize,
    comboCenterY,
    gradeSize,
    gradeY,
    timingSize,
    timingY,
  }
}

/**
 * 判定比 MAX 差的时候，告诉玩家是打早了还是打晚了。
 *
 * 偏差的符号约定在 judge.ts 里是统一的：**正数 = 打早，负数 = 打晚**，
 * 单点音符和长条收尾都遵守这一条。
 *
 * 偏差恰好为 0 时不显示 —— 那种情况通常是音符压根没被按过、
 * 直接被扫成 Miss，方向无从判断，硬猜一个反而会误导玩家。
 */
function timingLabel(feedback: HitFeedback): 'FAST' | 'LATE' | null {
  if (feedback.grade === Grade.Max) return null
  if (Math.abs(feedback.offsetMs) < 1) return null
  return feedback.offsetMs > 0 ? 'FAST' : 'LATE'
}

/**
 * 画判定结果：把最近一次判定显示在连击数字下面，比 MAX 差时再补一行 FAST / LATE。
 *
 * 以前这些字是按轨道飘在判定线上方的，轨道一密就糊成一片。
 * 现在集中到画面中轴、连击数字下方，一眼就能看清自己这一下打得怎么样。
 *
 * 这一层画在音符**上面**（连击数字则垫在音符下面）——
 * 判定结果是关键反馈，被音符切开会很难读。连击数字因为又大又淡，
 * 垫在下面反而是好事。
 */
function drawJudgement(g: CanvasRenderingContext2D, input: RenderInput): void {
  const { feedbacks, songTimeMs } = input
  if (feedbacks.length === 0) return

  // 只显示最近的一次判定。记录是按时间追加的，所以最后一个就是最新的。
  const latest = feedbacks[feedbacks.length - 1]
  const age = songTimeMs - latest.songTimeMs
  if (age < 0 || age > FEEDBACK_LIFETIME_MS) return

  const progress = age / FEEDBACK_LIFETIME_MS
  // 用平方让淡出前段慢、后段快，读起来更舒服
  const alpha = 1 - progress * progress

  const place = judgementLayout(input.layout)

  g.textAlign = 'center'
  g.textBaseline = 'middle'

  g.globalAlpha = alpha
  g.fillStyle = GRADE_COLORS[latest.grade]
  g.font = `700 ${place.gradeSize.toFixed(1)}px system-ui, sans-serif`
  g.fillText(GRADE_LABELS[latest.grade], place.centerX, place.gradeY)

  const timing = timingLabel(latest)
  if (timing !== null) {
    g.globalAlpha = alpha * 0.85
    g.fillStyle = timing === 'FAST' ? COLOR_TIMING_FAST : COLOR_TIMING_LATE
    g.font = `600 ${place.timingSize.toFixed(1)}px system-ui, sans-serif`
    g.fillText(timing, place.centerX, place.timingY)
  }

  g.globalAlpha = 1
}

/**
 * 画 COMBO 数字。
 *
 * 只在连击 >= 2 时显示 —— 打出 1 连就蹦一个大数字会非常吵。
 */
function drawCombo(g: CanvasRenderingContext2D, input: RenderInput): void {
  const { combo } = input.stats
  if (combo < 2) return

  const place = judgementLayout(input.layout)

  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.globalAlpha = 0.42
  g.fillStyle = COLOR_TEXT
  g.font = `700 ${place.comboSize.toFixed(1)}px system-ui, sans-serif`
  g.fillText(String(combo), place.centerX, place.comboCenterY)

  g.globalAlpha = 1
}

// ---------------------------------------------------------------------------
// 倒计时与庆祝
// ---------------------------------------------------------------------------

/**
 * 画准备倒计时。
 *
 * 倒计时期间歌曲时间是负数（见 SongClock.play 的 leadInMs 参数），
 * 音符还没落到画面上 —— 这段时间本来就是留给玩家把手指放到键位上的。
 * 所以这里只需要一个看得清的数字，不加多余的东西干扰。
 *
 * 进位换算在 core/countdown.ts，那里有单元测试。
 */
function drawCountdown(g: CanvasRenderingContext2D, input: RenderInput): void {
  const remaining = input.countdownRemainingMs
  if (remaining <= 0) return

  const { playfieldLeft, playfieldWidth, judgeLineY } = input.layout
  const centerX = playfieldLeft + playfieldWidth / 2
  const centerY = judgeLineY * 0.42

  const { seconds, progress } = countdownTick(remaining)

  const baseSize = Math.min(playfieldWidth * 0.34, 120)
  // 每个数字都从"大一点、亮一点"缩到"小一点、暗一点"。
  // 这样即使眼睛没盯着数字本身，余光也能感觉到节奏在推进。
  const size = baseSize * (1.3 - 0.3 * progress)

  g.textAlign = 'center'
  g.textBaseline = 'middle'

  g.globalAlpha = 1 - 0.4 * progress
  g.fillStyle = COLOR_TEXT
  g.font = `700 ${size.toFixed(1)}px system-ui, sans-serif`
  g.fillText(String(seconds), centerX, centerY)

  // 「准备」两个字：让玩家知道这是倒计时，而不是页面卡住了
  g.globalAlpha = 0.6
  g.fillStyle = COLOR_TEXT_DIM
  g.font = '600 14px system-ui, sans-serif'
  g.fillText('准备', centerX, centerY - baseSize * 0.86)

  g.globalAlpha = 1
  drawCountdownBar(g, input, remaining)
}

/** 画一条随时间缩短的进度条，给整个倒计时一个总体进度感。 */
function drawCountdownBar(
  g: CanvasRenderingContext2D,
  input: RenderInput,
  remaining: number,
): void {
  const { playfieldLeft, playfieldWidth, judgeLineY } = input.layout

  const total = Math.max(1, input.countdownTotalMs)
  const ratio = Math.min(1, Math.max(0, remaining / total))

  const barWidth = Math.min(playfieldWidth * 0.66, 280)
  const x = playfieldLeft + (playfieldWidth - barWidth) / 2
  const y = judgeLineY * 0.42 + Math.min(playfieldWidth * 0.34, 120) * 0.62

  g.fillStyle = 'rgba(255, 255, 255, 0.14)'
  g.fillRect(x, y, barWidth, 3)

  g.globalAlpha = 0.85
  g.fillStyle = COLOR_TEXT
  g.fillRect(x, y, barWidth * ratio, 3)
  g.globalAlpha = 1
}

/**
 * 画全连击庆祝动画。
 *
 * 触发时机是「最后一个音符判完、并且整首一个都没漏」的那一刻（见 Engine.checkFullCombo）。
 * 时间曲线在 core/celebration.ts，那里有单元测试。
 *
 * 三段构成：
 *   ① 达成瞬间的全屏闪光（很短，170ms 就衰减完）
 *   ② 从中间向两侧展开的金色横幅
 *   ③ 带回弹放大 + 发光外描边的文字
 */
function drawFullCombo(g: CanvasRenderingContext2D, input: RenderInput): void {
  if (input.fullComboAtMs < 0) return

  const frame = fullComboAnimation(input.songTimeMs - input.fullComboAtMs)
  if (!frame.visible) return

  const { width, height, playfieldWidth, judgeLineY } = input.layout
  // 刻意以整个画布居中，而不是以轨道居中 —— 这是"演出"，让它盖住整个画面更有气势
  const centerX = width / 2
  const centerY = judgeLineY * 0.42

  // ① 全屏闪光
  if (frame.flash > 0) {
    g.fillStyle = `rgba(255, 255, 255, ${(frame.flash * 0.22).toFixed(3)})`
    g.fillRect(0, 0, width, height)
  }

  // ② 从中间向两侧展开的横幅
  const bandWidth = width * frame.bandProgress
  const bandHeight = Math.min(height * 0.16, 96)
  const bandTop = centerY - bandHeight / 2

  g.globalAlpha = frame.alpha * 0.5
  g.fillStyle = FC_BAND_COLOR
  g.fillRect(centerX - bandWidth / 2, bandTop, bandWidth, bandHeight)

  g.globalAlpha = frame.alpha * 0.95
  g.fillStyle = FC_EDGE_COLOR
  g.fillRect(centerX - bandWidth / 2, bandTop, bandWidth, 2)
  g.fillRect(centerX - bandWidth / 2, bandTop + bandHeight - 2, bandWidth, 2)

  // ③ 文字。回弹放大 + 一层外发光
  const baseSize = Math.min(playfieldWidth * 0.2, width * 0.08, 56)

  g.globalAlpha = frame.alpha
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `800 ${(baseSize * frame.scale).toFixed(1)}px system-ui, sans-serif`
  g.shadowColor = FC_TEXT_GLOW
  g.shadowBlur = 26 * frame.scale
  g.fillStyle = FC_TEXT_COLOR
  g.fillText('FULL COMBO!!!', centerX, centerY)

  // ⚠️ shadowBlur / shadowColor 是**画布状态**，画完必须手动清掉。
  //    它会一直留着，把之后画的所有东西（暂停提示等等）都糊上一层光晕。
  g.shadowBlur = 0
  g.shadowColor = 'transparent'

  g.globalAlpha = 1
}

// ---------------------------------------------------------------------------
// 计分板
// ---------------------------------------------------------------------------

/** 画左上角分数和右上角准确率。 */
function drawScoreboard(g: CanvasRenderingContext2D, input: RenderInput): void {
  const { stats } = input

  // 只有在「还在倒计时 + 一个音符都还没判过」时才收起计分板 ——
  // 那时候显示「0 分 / 100.00%」既没意义又容易让人以为已经开始了。
  // 暂停恢复时已经有判定记录了，计分板要照常显示，不然玩家会以为分数丢了。
  if (input.countdownRemainingMs > 0 && stats.judged === 0) return

  const { width, judgeLineY } = input.layout

  g.textBaseline = 'top'

  // 分数：左上角
  g.textAlign = 'left'
  g.fillStyle = COLOR_TEXT
  g.font = '600 20px system-ui, sans-serif'
  g.fillText(stats.score.toLocaleString('en-US'), 16, 14)

  g.fillStyle = COLOR_TEXT_DIM
  g.font = '12px system-ui, sans-serif'
  g.fillText(`${stats.judged} / ${stats.total}`, 16, 40)

  // 准确率：右上角
  g.textAlign = 'right'
  g.fillStyle = COLOR_TEXT
  g.font = '600 20px system-ui, sans-serif'
  g.fillText(`${(stats.accuracy * 100).toFixed(2)}%`, width - 16, 14)

  // 最大连击：右上角第二行
  g.fillStyle = COLOR_TEXT_DIM
  g.font = '12px system-ui, sans-serif'
  g.fillText(`max combo ${stats.maxCombo}`, width - 16, 40)

  // 判定线附近给一个小的判定统计条，方便立刻看清自己哪个等级打得多。
  // 只在打了一会儿之后才显示，避免开局一串 0 很吵。
  if (stats.judged > 0) {
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    const lineHeight = 14
    let y = judgeLineY + 18
    g.font = '12px system-ui, sans-serif'
    for (let grade = 0; grade < GRADE_LABELS.length; grade++) {
      const count = stats.counts[grade]
      if (count === 0) continue
      g.fillStyle = GRADE_COLORS[grade]
      g.globalAlpha = 0.85
      g.fillText(`${GRADE_LABELS[grade]}  ${count}`, 16, y)
      y += lineHeight
    }
    g.globalAlpha = 1
  }

  g.textBaseline = 'alphabetic'
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 给颜色加透明度。
 *
 * 结果做了缓存：这个函数在每帧、每个音符上都会被调用，
 * 如果每次都重新解析十六进制字符串会产生大量临时字符串，白白触发 GC。
 */
const alphaCache = new Map<string, string>()

function withAlpha(hex: string, alpha: number): string {
  const key = `${hex}|${alpha}`
  const cached = alphaCache.get(key)
  if (cached !== undefined) return cached

  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const result = `rgba(${r}, ${g}, ${b}, ${alpha})`
  alphaCache.set(key, result)
  return result
}
