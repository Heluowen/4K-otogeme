/**
 * SongClock —— 把 Web Audio 的音频时钟包装成「歌曲时间」。
 *
 * ============================ 为什么不能省掉这一层 ============================
 *
 * 1. `<audio>` 元素的 currentTime 精度只有几百毫秒，还会随浏览器实现抖动，
 *    判定绝对不能用它。
 * 2. `AudioBufferSourceNode` 是一次性的：start() 之后不能暂停、不能续播，
 *    只能 stop() 然后重新 new 一个。所以"当前播到哪儿了"必须我们自己记。
 * 3. 音频是唯一稳定的时间基准。requestAnimationFrame 的帧间隔会抖，标签页切到后台
 *    会被节流到 1fps，setInterval 会累积漂移 —— 但它们都不影响音频时钟。
 *    所以：**渲染读音频时钟，而不是渲染驱动时间**。
 *
 * 核心状态只有一个：
 *     startCtxTime = 「歌曲第 0ms」对应的 AudioContext.currentTime 时刻
 * 于是    歌曲时间 = (当前音频时钟 - startCtxTime) × 1000
 */
/**
 * 最小的调度提前量（秒）。
 *
 * 不能把 start() 的时刻设成 ctx.currentTime —— 它离"真正发出声音"还有一段
 * 调度延迟，结果就是开头一小截被吞掉、音符和声音错开。
 * 即使玩家把倒计时设成 0 秒，也要保留这么多余量。
 */
const MIN_LEAD_IN_SEC = 0.12

export class SongClock {
  private readonly ctx: AudioContext
  private readonly buffer: AudioBuffer

  /** 正在播放的音源；为 null 表示当前是暂停状态 */
  private source: AudioBufferSourceNode | null = null

  /** 关键状态：歌曲第 0ms 对应 AudioContext.currentTime 的哪个时刻（秒） */
  private startCtxTime = 0

  /** 暂停时记住的播放位置（秒）。注意这里**不含** userOffsetMs，避免重复叠加 */
  private pausedAtSec = 0

  /**
   * 用户校准偏移（毫秒）。
   *
   * 用途：补偿音频输出延迟、以及某些音频文件（尤其是 MP3 的编码器补零）带来的
   * 系统性偏移。第 1–3 步可以先留 0，但它同样影响"音符压不压得住鼓点"。
   * 第 4 步做延迟校准页时，就是把玩家敲出来的平均偏差写进这个字段。
   */
  userOffsetMs = 0

  constructor(ctx: AudioContext, buffer: AudioBuffer) {
    this.ctx = ctx
    this.buffer = buffer
  }

  /** 音频总时长（ms） */
  get durationMs(): number {
    return this.buffer.duration * 1000
  }

  get isPlaying(): boolean {
    return this.source !== null
  }

  /**
   * 开始播放（或从指定位置开始播放）。
   *
   * @param fromMs   从歌曲的第几毫秒开始。省略表示从当前位置继续。
   * @param leadInMs 提前多久排期 —— 这就是"准备倒计时"。
   *                 这段时间里歌曲时间是负数，音符还没落到画面上，
   *                 玩家正好用它把手指放到键位上。省略或传 0 时只保留最小调度余量。
   */
  async play(fromMs?: number, leadInMs = 0): Promise<void> {
    // 浏览器要求 AudioContext 必须由用户手势唤醒，否则一直是 suspended（无声）。
    // 这里每次播放都检查一次，代价极小，能避免"点了没反应"的经典问题。
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume()
    }

    this.stopSource()

    const offsetSec = Math.max(0, (fromMs ?? this.elapsedMs()) / 1000)

    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
    source.connect(this.ctx.destination)

    // 关键：leadInSec 会**直接反映到歌曲时间上**。
    // 提前 3 秒开始，songTimeMs() 就会从 -3000 一路涨到 0 ——
    // 倒计时不是画上去的遮罩，而是真实的前置时间，音符在那期间已经在正常下落。
    // 最后那段 120ms 是为了让音频调度有充足余量，不是给玩家看的。
    const leadInSec = Math.max(MIN_LEAD_IN_SEC, Math.max(0, leadInMs) / 1000)
    const when = this.ctx.currentTime + leadInSec
    source.start(when, offsetSec)

    // 由 when 和起始偏移反推出"歌曲 0ms 对应的音频时刻"
    this.startCtxTime = when - offsetSec

    // 播放自然结束时把 source 置空，让 isPlaying 回到 false（否则按钮状态会和实际不符）
    source.onended = () => {
      if (this.source === source) {
        this.source = null
        this.pausedAtSec = this.buffer.duration
      }
    }

    this.source = source
  }

  /** 暂停。把当前位置记下来，下次 play() 从这里继续。 */
  pause(): void {
    if (this.source === null) return
    this.pausedAtSec = Math.max(0, this.elapsedMs()) / 1000
    this.stopSource()
  }

  /** 跳转到指定歌曲时间（ms）。 */
  seek(ms: number): void {
    const wasPlaying = this.source !== null
    this.stopSource()
    this.pausedAtSec = Math.max(0, ms) / 1000
    if (wasPlaying) {
      // play() 是异步的（可能要 resume 上下文），这里不需要等它
      void this.play(ms)
    }
  }

  /**
   * 当前歌曲时间（ms），**以听众实际听到的位置为准**。
   * 这是渲染和判定唯一应该使用的时间。
   */
  songTimeMs(): number {
    return this.elapsedMs() + this.userOffsetMs
  }

  /**
   * 把 `performance.now()` 时间轴上的一个时刻，映射成歌曲时间（ms）。
   *
   * 第 4 步的判定会用到这里：键盘事件的 `event.timeStamp` 就在 performance 时间轴上，
   * 我们要把它换算成"玩家按下这一下，对应的歌曲时间是多少"。
   *
   * 做法：`getOutputTimestamp()` 会同时给出
   *   - contextTime：此刻正在被扬声器播放的那个采样点的音频时钟位置
   *   - performanceTime：同一瞬间的 performance 时刻
   * 有了这一对锚点，就能把任意 performance 时刻线性映射回音频时钟。
   */
  perfToSongTime(perfMs: number): number {
    if (this.source === null) return this.songTimeMs()

    const ts = this.ctx.getOutputTimestamp()
    const ctxTime = ts.contextTime !== undefined && ts.contextTime > 0 ? ts.contextTime : this.ctx.currentTime
    const perfAtCtx = ts.performanceTime !== undefined && ts.performanceTime > 0 ? ts.performanceTime : performance.now()

    const ctxAtEvent = ctxTime + (perfMs - perfAtCtx) / 1000
    return (ctxAtEvent - this.startCtxTime) * 1000 + this.userOffsetMs
  }

  /** 释放音频资源。切歌时需要调用，否则旧的音频数据会一直占着内存。 */
  dispose(): void {
    this.stopSource()
  }

  // ---------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------

  /** 原始播放进度（ms），不叠加 userOffsetMs */
  private elapsedMs(): number {
    if (this.source === null) return this.pausedAtSec * 1000
    return (this.heardCtxTime() - this.startCtxTime) * 1000
  }

  /**
   * 「此刻耳朵听到的」音频时钟位置。
   *
   * `getOutputTimestamp().contextTime` 表示正在被输出的采样点，它比 currentTime
   * 落后一个输出延迟（几十毫秒）。用它做渲染，画面才能和声音对齐 —— 这正是
   * 音游最关键的"手感"来源。个别浏览器不提供有效值，退回到 currentTime。
   */
  private heardCtxTime(): number {
    const ts = this.ctx.getOutputTimestamp()
    if (ts.contextTime !== undefined && ts.contextTime > 0) return ts.contextTime
    return this.ctx.currentTime
  }

  /** 停止并丢弃当前音源 */
  private stopSource(): void {
    if (this.source === null) return
    const source = this.source
    // 先清空引用，再 stop —— 否则 onended 回调里会误判成"自然播放结束"
    this.source = null
    source.onended = null
    try {
      source.stop()
    } catch {
      // 已经停过了，忽略
    }
    source.disconnect()
  }
}
