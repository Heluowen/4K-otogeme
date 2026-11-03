import type { Chart, Note } from './types'

/**
 * Judge —— 判定引擎。
 *
 * ============================ 职责边界 ============================
 *
 * 它只做三件事：
 *   1. 接收「某条轨道在第几毫秒被按下 / 松开」
 *   2. 判断这一下命中了哪个音符、给什么评级
 *   3. 维护连击、准确率、分数
 *
 * 它**完全不知道**键盘、Canvas、音频时钟的存在。时间是由调用方（Engine）
 * 换算好之后喂进来的。这样可以脱离浏览器单元测试，也方便以后接触摸屏 / 手柄。
 *
 * ============================ 判定窗口 ============================
 *
 * 用 osu!mania 的公式，从谱面的 OverallDifficulty 推导出对称的 ± 窗口。
 *
 * ============================ 两条时间线必须对齐 ============================
 *
 * 判定用的时间只有一个是可信的：**按键事件自己的时间戳**换算出来的歌曲时间。
 * 绝对不能用「处理这一下的那一帧的歌曲时间」—— 帧间隔有 7~16ms 抖动，
 * 而且事件从硬件到 JS 还有一段延迟，那点误差直接就吃掉整个 MAX 窗口。
 * 所以 Engine 会先处理输入、再扫描过期音符，顺序不能反（见 Engine.frame）。
 */

/** 判定等级。数值同时是「好坏顺序」：0 最好，5 最差。 */
export const Grade = {
  Max: 0,
  G300: 1,
  G200: 2,
  G100: 3,
  G50: 4,
  Miss: 5,
} as const

export type Grade = (typeof Grade)[keyof typeof Grade]

/** 等级总数 */
export const GRADE_COUNT = 6

/** 界面显示用的名称 */
export const GRADE_LABELS: readonly string[] = ['MAX', '300', '200', '100', '50', 'MISS']

/** 界面显示用的颜色 */
export const GRADE_COLORS: readonly string[] = [
  '#8fe3ff',
  '#4da3ff',
  '#7ad9a0',
  '#ffd24d',
  '#ff9a5c',
  '#ff5c7a',
]

/** 各等级在准确率里的权重（MISS 不计分） */
const GRADE_WEIGHT: readonly number[] = [300, 300, 200, 100, 50, 0]

/** 判定窗口，单位毫秒，都是 **半宽**（也就是说实际区间是 ± 值） */
export interface JudgeWindows {
  max: number
  g300: number
  g200: number
  g100: number
  g50: number
  /** 超过这个偏差就算 Miss；同时也是"过期多久之后自动判 Miss"的阈值 */
  miss: number
}

/**
 * 从 OverallDifficulty 推导判定窗口（osu!mania 公式）。
 *
 * 这套系数来自 osu!mania 的稳定版实现。如果以后要和别的音游对齐手感，
 * 改这一个函数就够了 —— 判定逻辑本身不关心具体数值。
 */
export function windowsFromOverallDifficulty(overallDifficulty: number): JudgeWindows {
  const od = Math.min(10, Math.max(0, overallDifficulty))
  return {
    // MAX 窗口是固定的，不随 OD 变化
    max: 16,
    g300: 64 - 3 * od,
    g200: 97 - 3 * od,
    g100: 127 - 3 * od,
    g50: 151 - 3 * od,
    miss: 188 - 3 * od,
  }
}

/**
 * 输入宽限（ms）。
 *
 * 为什么需要它：按键事件是按浏览器自己的节奏派发的，可能落在两次渲染帧之间。
 * 假设某个音符即将过期，上一帧的扫描把它判成了 Miss，紧接着这一帧才收到
 * 「其实在过期前就按下去了」的按键事件 —— 那一下就会被吃掉。
 *
 * 所以扫描过期音符时往后多等这么久，给迟到的事件留出余地。
 * 人眼对"Miss 晚 40ms 出现"几乎没有感知，但少判一个 Miss 是实打实的。
 */
const INPUT_GRACE_MS = 50

/** 判定特效在画面上保留多久（ms），超时就从列表里清掉 */
const FEEDBACK_LIFETIME_MS = 600

/**
 * 音符的运行时状态。
 *
 * 之所以导出：渲染层也要用 —— 它需要跳过**已经判完**的音符
 * （原因见 `Judge.noteStates` 的说明）。
 */
export const NOTE_PENDING = 0
export const NOTE_HOLDING = 1
export const NOTE_RESOLVED = 2

/** 一次判定的记录，渲染层用它画飘字 */
export interface HitFeedback {
  lane: number
  grade: Grade
  /** 这次判定发生时的歌曲时间（ms），用于淡出 */
  songTimeMs: number
  /** 带符号偏差（ms）：正数表示打早了，负数表示打晚了 */
  offsetMs: number
  /** 是不是长条收尾 */
  isHoldTail: boolean
}

/** 判定统计数据快照 */
export interface JudgeStats {
  /** 当前连击 */
  combo: number
  /** 本局最大连击 */
  maxCombo: number
  /** 分数，0 ~ 1000000 */
  score: number
  /** 准确率，0 ~ 1 */
  accuracy: number
  /** 各等级的数量，下标对应 Grade */
  counts: readonly number[]
  /** 已判定的音符数 */
  judged: number
  /** 音符总数 */
  total: number
  /**
   * 所有有效命中的**带符号**偏差平均值（ms）。
   * 这个数字是延迟校准的关键：如果是稳定的 +18ms，说明整体有系统性偏移，
   * 把它加回音频偏移就能一次修正。
   */
  meanOffsetMs: number
  /** 参与平均的样本数。太少的话平均值不可信 */
  meanOffsetSamples: number
  /** 空敲次数（按键时附近没有音符）。不断连，只做提示 */
  ghostTaps: number
  /** 是不是所有音符都判完了 */
  finished: boolean
}

export class Judge {
  private readonly notes: readonly Note[]
  private readonly keyCount: number
  private readonly windows: JudgeWindows
  private readonly totalNotes: number

  /** 每个音符的状态，下标与 chart.notes 一致 */
  private readonly state: Uint8Array
  /** 每个音符最终评级的数值，state 为 Resolved 时有效 */
  private readonly grade: Uint8Array
  /** 长条**头部**的评级。最终评级取头部和尾部里较差的那个 */
  private readonly headGrade: Uint8Array

  /** 每条轨道上、按时间排好序的音符下标 */
  private readonly laneNotes: number[][]
  /**
   * 每条轨道的扫描起点。
   * 因为音符在轨道内按时间有序，已经彻底过期的音符不会再被用到，
   * 所以这个指针只增不减 —— 让判定变成「只扫描窗口附近的一小段」而不是整个谱面。
   */
  private readonly laneFirst: Int32Array
  /** 每条轨道当前正在保持的长条下标，-1 表示没有 */
  private readonly activeHold: Int32Array

  private combo = 0
  private maxCombo = 0
  private readonly counts: number[] = new Array<number>(GRADE_COUNT).fill(0)
  private weightSum = 0
  private judgedCount = 0
  private offsetSum = 0
  private offsetSamples = 0
  private ghostTaps = 0
  private feedbacks: HitFeedback[] = []

  constructor(chart: Chart) {
    this.notes = chart.notes
    this.keyCount = chart.keyCount
    this.totalNotes = chart.notes.length
    this.windows = windowsFromOverallDifficulty(chart.meta.overallDifficulty)

    this.state = new Uint8Array(this.totalNotes)
    this.grade = new Uint8Array(this.totalNotes)
    this.headGrade = new Uint8Array(this.totalNotes)

    this.laneNotes = Array.from({ length: this.keyCount }, () => [] as number[])
    this.activeHold = new Int32Array(this.keyCount).fill(-1)

    // chart.notes 已经按时间升序，所以按顺序 push 进各轨道的列表，轨道内自然也是有序的
    for (let i = 0; i < this.totalNotes; i++) {
      const column = this.notes[i].column
      if (column >= 0 && column < this.keyCount) {
        this.laneNotes[column].push(i)
      }
    }

    this.laneFirst = new Int32Array(this.keyCount)
  }

  /** 当前使用的判定窗口，UI 显示用 */
  get judgeWindows(): JudgeWindows {
    return this.windows
  }

  /**
   * 重置到「还没开始打」的状态。
   * 重来一局时必须调用，否则上一次的连击和分数会残留。
   */
  reset(): void {
    this.state.fill(NOTE_PENDING)
    this.grade.fill(0)
    this.headGrade.fill(0)
    this.laneFirst.fill(0)
    this.activeHold.fill(-1)
    this.combo = 0
    this.maxCombo = 0
    this.counts.fill(0)
    this.weightSum = 0
    this.judgedCount = 0
    this.offsetSum = 0
    this.offsetSamples = 0
    this.ghostTaps = 0
    this.feedbacks = []
  }

  /**
   * 每帧推进一次。
   *
   * ⚠️ 调用顺序要求：必须先处理完这一帧收到的所有按键事件，再调用本方法。
   * 否则扫描出来的 Miss 会把「其实赶上了」的按键吃掉。见 INPUT_GRACE_MS。
   */
  update(songTimeMs: number): void {
    this.sweepMisses(songTimeMs)
    this.completeHolds(songTimeMs)
    this.pruneFeedbacks(songTimeMs)
  }

  /**
   * 某条轨道被按下。
   *
   * @param songTimeMs 这一下按下时对应的歌曲时间（由 Engine 用事件自己的时间戳换算）
   */
  press(lane: number, songTimeMs: number): void {
    if (lane < 0 || lane >= this.keyCount) return

    const list = this.laneNotes[lane]
    let target = -1
    let offset = 0

    for (let cursor = this.laneFirst[lane]; cursor < list.length; cursor++) {
      const index = list[cursor]
      const delta = this.notes[index].time - songTimeMs

      // delta > 0 表示这个音符还在未来。
      // 列表按时间升序，所以后面只会更远，可以直接收工。
      if (delta > this.windows.miss) break

      // 已经判过的（含正在保持的长条）跳过
      if (this.state[index] !== NOTE_PENDING) continue

      // 已经过期太久、正处在"输入宽限"区间里的音符不算数。
      // 它马上就会被扫描判成 Miss；如果在这里被消费掉，
      // 就会把玩家为**后面那个音符**按的这一下白白吃掉。
      if (delta < -this.windows.miss) continue

      // ★ 取「最早的那个未判定音符」，而不是「偏差最小的那个」。
      //
      // 这是音游里不能违反的一条规则：同一轨上的音符必须按时间顺序依次判掉，
      // 不允许跳过。因为如果允许挑最接近的，那么一串同轨连打（jack）就会
      // 全都被算到后面那个音符上，前面直接变成 Miss —— 手感会彻底错乱。
      //
      // 真实 osu!mania 也是这样：过期音符会被立刻自动判 Miss，
      // 所以"最早的未判定音符"永远就是当前该打的那个。
      target = index
      offset = delta
      break
    }

    if (target < 0) {
      // 空敲：此刻没有该打的音符。
      // 主流音游都不会因为空敲断连（不然手抖一下就毁了），这里只计数。
      this.ghostTaps++
      return
    }

    const note = this.notes[target]
    const grade = this.gradeFor(Math.abs(offset))

    if (note.endTime > note.time) {
      // 长条：头部先记下来，等按住到结尾（或松手）时再最终结算。
      // 要先把状态改成 Holding，否则后续的 keydown 会重复命中同一个音符。
      this.state[target] = NOTE_HOLDING
      this.headGrade[target] = grade
      this.activeHold[lane] = target
      this.pushFeedback(lane, grade, songTimeMs, offset, false)
    } else {
      this.resolve(target, grade, songTimeMs, offset, false)
    }
  }

  /** 某条轨道被松开。只有长条会关心这件事。 */
  release(lane: number, songTimeMs: number): void {
    if (lane < 0 || lane >= this.keyCount) return

    const index = this.activeHold[lane]
    if (index < 0) return

    this.activeHold[lane] = -1
    const note = this.notes[index]
    // > 0 表示松早了
    const early = note.endTime - songTimeMs

    // 松得太早 → 整条断掉。
    // 否则按「离结尾差了多久」评级，并和头部评级取较差的那个。
    const tailGrade = early > this.windows.miss ? Grade.Miss : this.gradeFor(Math.abs(early))
    const finalGrade = Math.max(tailGrade, this.headGrade[index]) as Grade

    // 偏差必须和单点音符用**同一个符号约定**：正数 = 打早，负数 = 打晚。
    //
    // early = 结尾时间 - 松手时间，松早了就是正数，正好对应"打早"，直接传即可。
    // （这里以前传的是 -early，符号恰好反了 —— 长条样本会把延迟校准的
    // 统计均值往反方向拉，而且 FAST/LATE 提示也会显示反。）
    this.resolve(index, finalGrade, songTimeMs, early, true)
  }

  get stats(): JudgeStats {
    return {
      combo: this.combo,
      maxCombo: this.maxCombo,
      score:
        this.totalNotes === 0
          ? 0
          : Math.round((this.weightSum / (this.totalNotes * 300)) * 1_000_000),
      accuracy: this.judgedCount === 0 ? 1 : this.weightSum / (this.judgedCount * 300),
      counts: this.counts,
      judged: this.judgedCount,
      total: this.totalNotes,
      meanOffsetMs: this.offsetSamples === 0 ? 0 : this.offsetSum / this.offsetSamples,
      meanOffsetSamples: this.offsetSamples,
      ghostTaps: this.ghostTaps,
      finished: this.totalNotes > 0 && this.judgedCount >= this.totalNotes,
    }
  }

  /** 最近一小段时间内的判定记录，渲染层用来画飘字 */
  get recentFeedbacks(): readonly HitFeedback[] {
    return this.feedbacks
  }

  /**
   * 每个音符的运行时状态（下标与 `chart.notes` 一致）。
   *
   * 渲染层用它跳过**已经判完**的音符。平时其实看不出来 ——
   * 判定线以下都被遮罩盖住了。但暂停恢复时画面会倒带几秒，
   * 不跳过的话**已经打过的音符会重新落一遍**，看起来像在重打，非常困惑。
   *
   * 顺带还解决了一个观感问题：中途松手断掉的长条会立刻消失，
   * 而不是继续慢悠悠地落下去。
   *
   * ⚠️ 只读。调用方绝对不要修改这个数组。
   */
  get noteStates(): Uint8Array {
    return this.state
  }

  /** 某条轨道上是否还有正在保持的长条（渲染层用来画保持高亮） */
  isHolding(lane: number): boolean {
    return lane >= 0 && lane < this.keyCount && this.activeHold[lane] >= 0
  }

  // ---------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------

  /** 把过了判定窗口还没被按下的音符判成 Miss。 */
  private sweepMisses(songTimeMs: number): void {
    const deadline = songTimeMs - this.windows.miss - INPUT_GRACE_MS

    for (let lane = 0; lane < this.keyCount; lane++) {
      const list = this.laneNotes[lane]
      let cursor = this.laneFirst[lane]

      while (cursor < list.length) {
        const index = list[cursor]
        if (this.notes[index].time > deadline) break

        if (this.state[index] === NOTE_PENDING) {
          this.resolve(index, Grade.Miss, songTimeMs, 0, false)
        }
        // 注意：正在保持的长条（Holding）也会被指针跳过。
        // 这没问题 —— 它有 activeHold 单独盯着，靠松手或到达结尾来结算。
        cursor++
      }

      this.laneFirst[lane] = cursor
    }
  }

  /**
   * 一直按到长条结尾 → 直接算完成。
   *
   * 刻意**不要求玩家在结尾那一刻精确松手**：按到底就送一个满评，
   * 最终评级取头部和尾部里较差的那个，所以头部打得差依然会被惩罚。
   */
  private completeHolds(songTimeMs: number): void {
    for (let lane = 0; lane < this.keyCount; lane++) {
      const index = this.activeHold[lane]
      if (index < 0) continue

      const note = this.notes[index]
      if (songTimeMs < note.endTime) continue

      this.activeHold[lane] = -1
      this.resolve(index, this.headGrade[index] as Grade, songTimeMs, 0, true)
    }
  }

  /** 清掉已经过期很久的判定飘字，避免数组无限增长。 */
  private pruneFeedbacks(songTimeMs: number): void {
    if (this.feedbacks.length === 0) return
    const oldest = songTimeMs - FEEDBACK_LIFETIME_MS
    // 记录是按时间追加的，所以删掉的一定是前缀，直接 findIndex + splice 即可
    let keepFrom = 0
    while (keepFrom < this.feedbacks.length && this.feedbacks[keepFrom].songTimeMs < oldest) {
      keepFrom++
    }
    if (keepFrom > 0) this.feedbacks.splice(0, keepFrom)
  }

  /** 按偏差绝对值给出评级 */
  private gradeFor(absOffset: number): Grade {
    if (absOffset <= this.windows.max) return Grade.Max
    if (absOffset <= this.windows.g300) return Grade.G300
    if (absOffset <= this.windows.g200) return Grade.G200
    if (absOffset <= this.windows.g100) return Grade.G100
    if (absOffset <= this.windows.g50) return Grade.G50
    return Grade.Miss
  }

  /** 结算一个音符：写状态、记统计、更新连击。 */
  private resolve(
    index: number,
    grade: Grade,
    songTimeMs: number,
    offsetMs: number,
    isHoldTail: boolean,
  ): void {
    if (this.state[index] === NOTE_RESOLVED) return

    this.state[index] = NOTE_RESOLVED
    this.grade[index] = grade
    this.counts[grade]++
    this.judgedCount++

    if (grade === Grade.Miss) {
      this.combo = 0
    } else {
      this.combo++
      if (this.combo > this.maxCombo) this.maxCombo = this.combo
      this.weightSum += GRADE_WEIGHT[grade]
      // 只把真正打上的音符算进偏差统计 —— Miss 和空敲会污染平均值
      this.offsetSum += offsetMs
      this.offsetSamples++
    }

    this.pushFeedback(this.notes[index].column, grade, songTimeMs, offsetMs, isHoldTail)
  }

  private pushFeedback(
    lane: number,
    grade: Grade,
    songTimeMs: number,
    offsetMs: number,
    isHoldTail: boolean,
  ): void {
    // 长条头部和收尾各推一条。
    //
    // 以前收尾这条会被抑制掉（"同一轨不重复飘字"），但那是在判定结果按轨道飘字
    // 的时代的优化。现在界面上只有一处集中显示最近一次判定，
    // 抑制掉收尾就意味着**长条松手打得怎么样永远看不到** —— 而最终评级恰恰是
    // 取头部和收尾里较差的那个，收尾才是决定性的那一次。
    this.feedbacks.push({ lane, grade, songTimeMs, offsetMs, isHoldTail })
  }
}
