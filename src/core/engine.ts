import type { KeySound } from '../audio/key-sound'
import { renderFrame } from '../render/canvas'
import { computeLayout, type Layout } from '../render/layout'
import type { SongClock } from './clock'
import {
  MAX_NOTE_SIZE_LEVEL,
  MAX_TILT_DEGREES,
  MIN_NOTE_SIZE_LEVEL,
  type NoteShape,
} from './fall-style'
import { InputManager, type LaneKeyEvent } from './input'
import { Judge, type JudgeStats } from './judge'
import { ScrollModel } from './scroll'
import type { Chart, ScrollPoint } from './types'

/**
 * Engine —— 把「音频时钟 / 滚动模型 / 判定 / 渲染器」绑在一起的主循环。
 *
 * 每一帧的顺序是**固定的，不能调换**：
 *
 *   ① 处理这一帧收到的按键（用事件自己的时间戳换算歌曲时间）
 *   ② 推进判定（扫描过期音符、结算按到底的长条）
 *   ③ 读时钟拿当前歌曲时间，算出累积滚动距离
 *   ④ 渲染
 *
 * ① 必须在 ② 之前：判定引擎扫描过期音符时会判 Miss。如果先扫描再处理按键，
 * 那些"其实在过期前就按下去了、只是事件晚到一步"的按键就会被吃掉。
 * 详见 core/judge.ts 里 INPUT_GRACE_MS 的说明。
 *
 * 整个循环里没有任何"推进"逻辑 —— 音符不会因为帧过去而移动，
 * 它们的位置永远是「由当前歌曲时间算出来的」。所以掉帧不会造成累积误差。
 */

/** 每帧回传给 UI 的诊断数据 */
export interface EngineMetrics {
  fps: number
  /** 当前歌曲时间（ms） */
  songTimeMs: number
  /** 音频总时长（ms） */
  durationMs: number
  playing: boolean
  /** 谱面音符总数 */
  noteCount: number
  /** 已经越过判定线的音符数 */
  passedNotes: number
  /** 当前的累积滚动距离 S(now)，单位 px */
  scrollDistance: number
  /** 当前瞬时滚动速度，单位 px/ms */
  speedPxPerMs: number
  /** 当前设置的下落时间（ms） */
  fallTimeMs: number
  /** 真正生效的轨道倾斜角度（度）。窗口不够宽时会小于设置里的请求值，0 = 垂直 */
  tiltDegrees: number
  /** 当前生效的 SV 倍率。1.0 表示原速、此刻没有变速 */
  svMultiplier: number
  /** 判定统计（连击、准确率、分数、各等级数量……） */
  stats: JudgeStats
}

export interface EngineOptions {
  canvas: HTMLCanvasElement
  chart: Chart
  clock: SongClock
  /** 初始下落时间（ms） */
  fallTimeMs: number
  /** 是否忽略谱面自带的 SV 变速 */
  ignoreChartSv: boolean
  /** 谱面开始前的准备倒计时（ms）。0 表示不倒计时 */
  countdownMs: number
  /** 轨道倾斜角度（度）。0 = 垂直下落；上限 MAX_TILT_DEGREES */
  tiltDegrees: number
  /** 音符形状：方形还是圆形 */
  noteShape: NoteShape
  /** 音符大小档位，1–5。3 是基准 */
  noteSizeLevel: number
  /**
   * 按键音。由外部（app）持有并注入 —— 这样它的音色 buffer 只会生成一次，
   * 而且设置面板在没有引擎的时候也能试听。
   */
  keySound: KeySound
  /** 每帧回调，用于刷新 HUD */
  onMetrics: (metrics: EngineMetrics) => void
  /** 一局结束时回调一次 */
  onFinished: (stats: JudgeStats) => void
}

/** 下落时间的可调范围（ms）。太短看不清，太长音符太密。 */
export const FALL_TIME_MIN = 200
export const FALL_TIME_MAX = 1500

/** 队列里的一个输入事件 */
interface QueuedInput {
  lane: number
  perfTimeMs: number
  /** true = 按下，false = 松开 */
  isPress: boolean
}

export class Engine {
  readonly clock: SongClock
  readonly judge: Judge

  private readonly canvas: HTMLCanvasElement
  private readonly g: CanvasRenderingContext2D
  private readonly chart: Chart
  private readonly onMetrics: (metrics: EngineMetrics) => void
  private readonly onFinished: (stats: JudgeStats) => void
  private readonly resizeObserver: ResizeObserver
  private readonly input: InputManager

  private layout: Layout
  private scroll: ScrollModel

  /** 恒定速度（SV 倍率 1.0）下的滚动速度，用来反推当前生效的 SV 倍率 */
  private baseSpeed: number

  /** headDist[i] = S(notes[i].time)：音符头部的累积滚动距离 */
  private readonly headDist: Float64Array
  /** tailDist[i] = S(notes[i].endTime)：音符尾部的累积滚动距离 */
  private readonly tailDist: Float64Array

  private fallTimeMs: number
  private ignoreChartSv: boolean
  /** 请求的轨道倾斜角度（度）。真正生效的角度可能更小，见 layout.tiltDegrees */
  private tiltDegrees: number
  /** 音符形状 */
  private noteShape: NoteShape
  /** 音符大小档位（1–5），只是绘制参数，不影响布局和判定 */
  private noteSizeLevel: number
  /** 配置的倒计时时长（ms） */
  private countdownMs: number
  /**
   * 当前是否处在倒计时阶段。
   *
   * 不能靠「歌曲时间 < 0」判断：倒计时设成 0 时音频调度仍会保留 120ms 余量
   * （见 clock.ts 的 MIN_LEAD_IN_SEC），那 120ms 里歌曲时间同样是负数。
   * 而且暂停恢复的倒计时是从一个正数位置往回倒带的，压根不在 0 附近。
   */
  private countdownActive = false
  /**
   * 倒计时结束时对应的**歌曲时间**。
   * 谱面开头是 0；暂停恢复时是暂停位置。
   */
  private countdownUntilMs = 0

  /** 达成全连击的那一刻（歌曲时间 ms）。-1 表示还没达成 */
  private fullComboAtMs = -1
  /** 是否已经检查过全连击（保证只触发一次） */
  private fullComboChecked = false

  private readonly keySound: KeySound

  /**
   * 待处理的输入队列。
   * 按键事件先进队列，等下一帧开头按**收到顺序**统一交给判定 ——
   * 不在这里直接判，是为了让「先判输入、再扫 Miss」的顺序得到保证。
   */
  private readonly pendingInputs: QueuedInput[] = []

  /** 谱面最后一个音符结束的时间，用于判断整局是否结束 */
  private readonly lastNoteEndMs: number

  private running = false
  private rafId = 0
  private lastFrameAt = 0
  private fps = 0
  private finished = false

  constructor(options: EngineOptions) {
    this.canvas = options.canvas
    this.chart = options.chart
    this.clock = options.clock
    this.fallTimeMs = options.fallTimeMs
    this.ignoreChartSv = options.ignoreChartSv
    this.countdownMs = Math.max(0, Math.round(options.countdownMs))
    this.keySound = options.keySound
    this.tiltDegrees = Math.max(0, Math.min(MAX_TILT_DEGREES, options.tiltDegrees))
    this.noteShape = options.noteShape
    this.noteSizeLevel = Math.min(
      MAX_NOTE_SIZE_LEVEL,
      Math.max(MIN_NOTE_SIZE_LEVEL, Math.round(options.noteSizeLevel)),
    )
    this.onMetrics = options.onMetrics
    this.onFinished = options.onFinished

    // alpha: false 告诉浏览器画布不透明，可以省掉一次合成，略微更快
    const context = this.canvas.getContext('2d', { alpha: false })
    if (context === null) throw new Error('无法获取 Canvas 2D 绘图上下文')
    this.g = context

    this.judge = new Judge(this.chart)

    const notes = this.chart.notes
    this.headDist = new Float64Array(notes.length)
    this.tailDist = new Float64Array(notes.length)

    let lastEnd = 0
    for (const note of notes) {
      if (note.endTime > lastEnd) lastEnd = note.endTime
    }
    this.lastNoteEndMs = lastEnd

    // 先放占位值，紧接着的 resize() + rebuildScroll() 会用真实尺寸覆盖
    this.layout = computeLayout(1, 1, this.chart.keyCount, this.tiltDegrees)
    this.baseSpeed = 1
    this.scroll = new ScrollModel([{ time: 0, speed: 1 }])

    // 顺序很重要：先算布局（拿到判定线 y），再算滚动模型（速度依赖判定线 y）
    this.resize()
    this.rebuildScroll()

    // 键盘监听：事件只进队列，真正的判定留到帧开头统一做
    this.input = new InputManager({
      onPress: (event: LaneKeyEvent) => {
        // ★ 按键音必须在这里**当场**播，不能等下一帧统一处理。
        //   等一帧就是最多 16ms 的额外延迟，而"按下到出声"的延迟人耳极其敏感。
        //
        //   注意它绑的是"按键"而不是"命中"：空敲同样有声音。
        //   这是键盘反馈，不是判定反馈 —— 玩家需要听到自己明明按了。
        //
        //   暂停时不播（这时按键不代表任何操作），倒计时期间照常播。
        if (this.clock.isPlaying) this.keySound.play(event.lane)

        this.pendingInputs.push({ lane: event.lane, perfTimeMs: event.perfTimeMs, isPress: true })
      },
      onRelease: (event: LaneKeyEvent) => {
        this.pendingInputs.push({ lane: event.lane, perfTimeMs: event.perfTimeMs, isPress: false })
      },
    })
    this.input.attach()

    // 容器尺寸变化时（窗口缩放、面板从隐藏变显示）重新算布局。
    // 用 ResizeObserver 而不是 window.resize，因为容器变化不一定伴随窗口变化。
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas)
  }

  // ---------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------

  /** 启动渲染循环（但不自动播放音频）。 */
  mount(): void {
    if (this.running) return
    this.running = true
    this.lastFrameAt = 0
    this.rafId = requestAnimationFrame(this.frame)
  }

  /** 停止渲染循环、断开键盘监听、释放音频资源。换谱面时必须调用。 */
  destroy(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.input.detach()
    this.resizeObserver.disconnect()
    this.clock.dispose()
  }

  /** 播放 / 暂停。 */
  async togglePlay(): Promise<void> {
    if (this.clock.isPlaying) {
      // 暂停时把所有键松开：否则长条会一直停在"保持中"，
      // 而且恢复播放后那些键还会被当成按着，后续按键全被当成重复。
      this.input.releaseAll(performance.now())
      this.clock.pause()
      return
    }

    const position = this.clock.songTimeMs()

    // 已经播到结尾了再按播放，就从开头重来，而不是卡在末尾没反应
    if (position >= this.clock.durationMs - 16) {
      await this.restart()
      return
    }

    await this.startCountdown(Math.max(0, position))
  }

  /**
   * 从某个歌曲时间点开始播放，并先走一遍倒计时。
   *
   * ============================ 倒计时是「倒带」 ============================
   *
   * 倒计时期间歌曲时间会从 `untilMs - countdownMs` 一路涨到 `untilMs` ——
   * 也就是**画面往后倒带几秒再放一遍**。
   *
   * 为什么不做成"画面定格、数字在数"：倒带能让玩家重新看到接下来要打的音符，
   * 而不是盯着一个定格画面数三下。音频本身不会倒带，它只是在倒计时结束后
   * 从 `untilMs` 开始播。
   *
   * 倒带会带来一个副作用：已经打过的音符会重新落一遍、看着像在重打。
   * 这个由渲染层跳过 `NOTE_RESOLVED` 的音符来解决（见 Judge.noteStates）。
   *
   * @param untilMs 倒计时结束后开始播放的歌曲时间（谱面开头就是 0）
   */
  private async startCountdown(untilMs: number): Promise<void> {
    if (this.countdownMs <= 0) {
      this.countdownActive = false
      await this.clock.play(untilMs)
      return
    }

    this.countdownActive = true
    this.countdownUntilMs = untilMs
    await this.clock.play(untilMs, this.countdownMs)
  }

  /** 从头开始播放，并清空判定状态。 */
  async restart(): Promise<void> {
    this.judge.reset()
    this.pendingInputs.length = 0
    this.finished = false
    this.fullComboAtMs = -1
    this.fullComboChecked = false
    await this.startCountdown(0)
  }

  /**
   * 改变下落时间。
   *
   * 因为音符位置是由积分算出来的，改变速度不需要重启播放，也不影响判定时刻 ——
   * 只会让画面上的音符整体重新分布。
   */
  setFallTime(ms: number): void {
    const next = Math.min(FALL_TIME_MAX, Math.max(FALL_TIME_MIN, Math.round(ms)))
    if (next === this.fallTimeMs) return
    this.fallTimeMs = next
    this.rebuildScroll()
  }

  /** 是否忽略谱面自带的 SV 变速（想要恒定下落手感时打开）。 */
  setIgnoreChartSv(ignore: boolean): void {
    if (ignore === this.ignoreChartSv) return
    this.ignoreChartSv = ignore
    this.rebuildScroll()
  }

  /**
   * 设置倒计时时长（ms）。**下一次**倒计时生效 ——
   * 正在数的那一次不会被中途改掉，否则数字会突然跳变。
   */
  setCountdownMs(ms: number): void {
    this.countdownMs = Math.max(0, Math.round(ms))
  }

  /**
   * 设置轨道倾斜角度（度）。0 = 垂直下落。
   *
   * 倾斜**只改变画面几何，完全不影响判定** —— 音符到达判定线的时刻由音频时钟决定，
   * 哪怕轨道斜着画、下落还带加速，它在音符时间那一刻依然精确落在判定线上。
   * （加速曲线在两端严格取 0 和 1，就是为了保住这一点。）
   */
  setTiltDegrees(degrees: number): void {
    const next = Math.max(0, Math.min(MAX_TILT_DEGREES, degrees))
    if (next === this.tiltDegrees) return
    this.tiltDegrees = next
    // 角度变了，布局要重算 —— 实际偏移量和"真正生效的角度"都在布局里
    this.resize()
  }

  /** 设置音符形状。只是绘制方式的区别，不影响判定。 */
  setNoteShape(shape: NoteShape): void {
    this.noteShape = shape
  }

  /** 设置音符大小档位（1–5，3 是基准）。同样只影响绘制。 */
  setNoteSizeLevel(level: number): void {
    const next = Math.min(
      MAX_NOTE_SIZE_LEVEL,
      Math.max(MIN_NOTE_SIZE_LEVEL, Math.round(level)),
    )
    this.noteSizeLevel = next
  }

  /** 设置按键映射。codes[i] 是第 i 轨的 KeyboardEvent.code。 */
  setKeyBindings(codes: readonly string[]): void {
    this.input.setBindings(codes)
  }

  /**
   * 临时开关键盘输入。
   * 设置面板在"等待按键"时会关掉它，否则被绑定的键会同时触发捕获和游戏输入。
   */
  setInputEnabled(enabled: boolean): void {
    this.input.setEnabled(enabled)
  }

  /** 设置音频偏移（ms）。结算页的"自动修正"会调用它。 */
  setAudioOffset(ms: number): void {
    this.clock.userOffsetMs = ms
  }

  /** 一局是否已经结束 */
  get isFinished(): boolean {
    return this.finished
  }

  // ---------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------

  private resize(): void {
    const parent = this.canvas.parentElement
    const cssWidth = parent ? parent.clientWidth : this.canvas.clientWidth
    const cssHeight = parent ? parent.clientHeight : this.canvas.clientHeight
    // 面板还没显示出来（display:none）时尺寸是 0，此时不动布局，
    // 等 ResizeObserver 在面板显示后再叫我们一次。
    if (cssWidth < 1 || cssHeight < 1) return

    // 高分屏(devicePixelRatio > 1)下，如果画布的像素尺寸还等于 CSS 尺寸，
    // 1px 的线会被拉成模糊的灰带。把像素尺寸放大 dpr 倍，再用 setTransform
    // 把绘图坐标系缩回去 —— 业务代码依然按 CSS 像素思考。
    // 上限 2 是为了避免在 3x/4x 屏上白白多画几倍的像素。
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pixelWidth = Math.round(cssWidth * dpr)
    const pixelHeight = Math.round(cssHeight * dpr)
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }
    // 改 canvas.width 会重置绘图上下文的所有状态（包括变换），所以必须在这里重新设置
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0)

    this.layout = computeLayout(cssWidth, cssHeight, this.chart.keyCount, this.tiltDegrees)
    this.rebuildScroll()
  }

  /**
   * 重建滚动模型，并重新预计算所有音符的累积滚动距离。
   *
   * ★ 这里是「接入谱面 SV 变速」唯一需要改的地方。
   * 因为 ScrollModel 用的是积分模型（见 core/scroll.ts），
   * 把倍率乘进速度里就够了 —— 积分、剔除、渲染代码一行都不用动。
   * 这也正是当初选积分模型而不是「时间差 × 速度」的原因。
   */
  private rebuildScroll(): void {
    const { judgeLineY } = this.layout

    // 恒定速度：音符要用 fallTimeMs 毫秒走完 judgeLineY 像素
    //     speed = 距离 / 时间   (px/ms)
    this.baseSpeed = judgeLineY / Math.max(1, this.fallTimeMs)

    const points: ScrollPoint[] = [
      // 第一个分段刻意放在"很久以前"（约 2.8 小时前）。
      // 这保证了任何时刻都能查到速度，也符合 osu 的约定：
      // 第一条绿线之前的倍率就是 1.0（原速）。
      { time: -1e7, speed: this.baseSpeed },
    ]

    if (!this.ignoreChartSv) {
      // 谱面变速：把每个 SV 点的倍率乘到基准速度上。
      // 倍率只影响滚动速度，**不影响音符时间**，所以判定完全不受影响。
      for (const point of this.chart.speedPoints) {
        points.push({ time: point.time, speed: this.baseSpeed * point.multiplier })
      }
    }

    this.scroll = new ScrollModel(points)

    // 关键的性能优化：把 S(t) 提前算好。
    // S(t) 内部要做二分查找，如果放到每帧对每个音符现算，一秒钟就是几十万次查找。
    // 提前算完之后，每帧每个音符只剩一次减法。
    // 代价是下落时间或 SV 开关变化时必须整表重算 —— 这就是本方法存在的意义。
    const notes = this.chart.notes
    for (let i = 0; i < notes.length; i++) {
      this.headDist[i] = this.scroll.distance(notes[i].time)
      this.tailDist[i] = this.scroll.distance(notes[i].endTime)
    }
  }

  /** 主循环。用箭头函数属性是为了让 `this` 在 requestAnimationFrame 回调里也正确。 */
  private readonly frame = (timestamp: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.frame)

    // FPS 用指数滑动平均，否则读数每帧都在跳，根本看不清
    if (this.lastFrameAt > 0) {
      const delta = timestamp - this.lastFrameAt
      if (delta > 0) {
        const instant = 1000 / delta
        this.fps = this.fps === 0 ? instant : this.fps * 0.92 + instant * 0.08
      }
    }
    this.lastFrameAt = timestamp

    // ★ ① 先处理输入，② 再推进判定。顺序不能反，原因见类顶部的说明。
    this.drainInput()
    const songTimeMs = this.clock.songTimeMs()

    // 倒计时：歌曲时间到达目标就说明数完了，收起倒计时显示。
    // 剩余时长是从**歌曲时间**算的，所以谱面开头（目标 0）和暂停恢复
    // （目标是一个正数位置）走的是同一套逻辑。
    if (this.countdownActive && songTimeMs >= this.countdownUntilMs) {
      this.countdownActive = false
    }
    const countdownRemainingMs = this.countdownActive
      ? Math.max(0, this.countdownUntilMs - songTimeMs)
      : 0

    this.judge.update(songTimeMs)

    // 判定统计每帧只取一次 —— 取一次就会新建一个对象，
    // 而下面全连击判断、结束判断、渲染、HUD 回调都要用它。
    const stats = this.judge.stats
    this.checkFullCombo(songTimeMs, stats)
    this.checkFinished(songTimeMs, stats)

    // ③ 时间是"读"出来的，不是"累加"出来的
    const scrollDistanceNow = this.scroll.distance(songTimeMs)

    // ④ 渲染
    renderFrame(this.g, {
      chart: this.chart,
      layout: this.layout,
      headDist: this.headDist,
      tailDist: this.tailDist,
      scrollDistanceNow,
      playing: this.clock.isPlaying,
      songTimeMs,
      countdownRemainingMs,
      countdownTotalMs: this.countdownMs,
      noteStates: this.judge.noteStates,
      fullComboAtMs: this.fullComboAtMs,
      noteShape: this.noteShape,
      noteSizeLevel: this.noteSizeLevel,
      laneDown: this.collectLaneDown(),
      feedbacks: this.judge.recentFeedbacks,
      stats,
    })

    this.onMetrics(this.collectMetrics(songTimeMs, scrollDistanceNow, stats))
  }

  /** 每条轨道此刻是否被按住。渲染层用来画按下高亮，所以必须是普通数组（可跨模块只读使用）。 */
  private collectLaneDown(): boolean[] {
    const result: boolean[] = []
    for (let lane = 0; lane < this.chart.keyCount; lane++) {
      result.push(this.input.isDown(lane))
    }
    return result
  }

  /**
   * 把队列里的按键按收到顺序交给判定引擎。
   *
   * 按键事件自己的时间戳才是判定依据；这里只是把它换算成歌曲时间。
   * `perfToSongTime` 是一次线性映射，晚一帧调用也不会损失精度 ——
   * 因为它用的锚点（contextTime / performanceTime）始终描述同一个瞬间。
   */
  private drainInput(): void {
    if (this.pendingInputs.length === 0) return

    for (const item of this.pendingInputs) {
      const songTimeMs = this.clock.perfToSongTime(item.perfTimeMs)
      if (item.isPress) {
        this.judge.press(item.lane, songTimeMs)
      } else {
        this.judge.release(item.lane, songTimeMs)
      }
    }
    this.pendingInputs.length = 0
  }

  /**
   * 全部音符判完之后，检查是否达成了一个不漏的全连击。
   *
   * 判定"全连击"的依据是「最大连击 == 音符总数」：
   * 任何一个 Miss 都会把连击清零，所以两者相等等价于整首一个都没漏
   * （长条中途松手同样算 Miss）。
   *
   * 只在所有音符都判完的那一刻检查一次 —— 之后再改判定结果也不会重来。
   */
  private checkFullCombo(songTimeMs: number, stats: JudgeStats): void {
    if (this.fullComboChecked) return
    if (!stats.finished) return

    this.fullComboChecked = true

    if (stats.total > 0 && stats.maxCombo === stats.total) {
      this.fullComboAtMs = songTimeMs
    }
  }

  /** 判断一局是否结束，结束时只回调一次。 */
  private checkFinished(songTimeMs: number, stats: JudgeStats): void {
    if (this.finished) return

    // 结束有两种情况：
    //  ① 音频放完了
    //  ② 所有音符都判完了，并且最后一个音符过线之后又等了足够久
    //     （有些谱面音频尾部很长，硬等完整首歌会很无聊）
    const audioDone = !this.clock.isPlaying && songTimeMs >= this.clock.durationMs - 32
    const notesDone = stats.finished && songTimeMs >= this.lastNoteEndMs + 1500

    if (!audioDone && !notesDone) return

    this.finished = true
    this.onFinished(stats)
  }

  private collectMetrics(
    songTimeMs: number,
    scrollDistanceNow: number,
    stats: JudgeStats,
  ): EngineMetrics {
    const currentSpeed = this.scroll.speedAt(songTimeMs)
    return {
      fps: this.fps,
      songTimeMs,
      durationMs: this.clock.durationMs,
      playing: this.clock.isPlaying,
      noteCount: this.chart.notes.length,
      passedNotes: this.countPassedNotes(songTimeMs),
      scrollDistance: scrollDistanceNow,
      speedPxPerMs: currentSpeed,
      // 当前生效的 SV 倍率：把当前速度除以基准速度就还原出来了（HUD 显示用）
      svMultiplier: this.baseSpeed > 0 ? currentSpeed / this.baseSpeed : 1,
      fallTimeMs: this.fallTimeMs,
      tiltDegrees: this.layout.tiltDegrees,
      stats,
    }
  }

  /**
   * 统计已经越过判定线的音符数。
   *
   * 用二分查找而不是遍历：音符按时间有序，所以"时间 <= 当前时间"的必然是一段前缀，
   * 找到分界点即可。这样即使谱面有一万个音符，这个统计也是 O(log n)。
   */
  private countPassedNotes(songTimeMs: number): number {
    const notes = this.chart.notes
    let lo = 0
    let hi = notes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (notes[mid].time <= songTimeMs) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }
}
