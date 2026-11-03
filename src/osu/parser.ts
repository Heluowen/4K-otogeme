/**
 * `.osu` 文件解析器。
 *
 * `.osu` 是一个纯文本的 INI 风格格式，用 `[段名]` 分段：
 *
 *   osu file format v14
 *
 *   [General]
 *   AudioFilename: audio.mp3
 *   Mode: 3
 *
 *   [Metadata]
 *   Title: ...
 *   Artist: ...
 *
 *   [Difficulty]
 *   CircleSize: 4          ← mania 模式下这个就是键数
 *   OverallDifficulty: 8
 *
 *   [TimingPoints]
 *   0,500,4,2,0,100,1,0
 *
 *   [HitObjects]
 *   64,192,1000,1,0,0:0:0:0:
 *
 * 解析策略：
 *  - 逐行扫描，靠 `[段名]` 切换当前上下文；
 *  - `[TimingPoints]` 和 `[HitObjects]` 是逗号分隔的表格，单独处理；
 *  - 其余段都是 `Key: Value`。
 *
 * 注意这里**不做轨道号换算**。因为换算需要知道 CircleSize（键数），
 * 虽然 [Difficulty] 在标准顺序里排在 [HitObjects] 前面，但依赖"文件里段的顺序"
 * 是脆弱的。所以这里只保留原始 x 坐标，等整个文件读完、拿到了确定的键数，
 * 再由 loader 做换算。
 */

/** `[TimingPoints]` 里的一行 */
export interface OsuTimingPoint {
  /** 这一行从什么时刻开始生效（ms） */
  time: number
  /**
   * 第 2 列。含义取决于 `uninherited`：
   *  - BPM 点：每拍有多少毫秒（120 BPM → 500）
   *  - SV 点：负数，真实的滚动倍率 = -100 / beatLength
   */
  beatLength: number
  /** true = BPM 点（红线），false = SV 点（绿线） */
  uninherited: boolean
}

/** `[HitObjects]` 里的一行（保留了原始坐标，尚未换算成轨道号） */
export interface OsuHitObject {
  /** 原始 x 坐标，取值 0..512 */
  x: number
  /** 到达判定线的时刻（ms） */
  time: number
  /** 长条的结束时刻（ms）；单点音符等于 time */
  endTime: number
  /** 是不是长条 */
  isHold: boolean
}

/** 一个 `.osu` 文件的解析结果 */
export interface OsuBeatmap {
  /** 文件格式版本，取自首行 `osu file format v14` */
  formatVersion: number
  /** [General] AudioFilename */
  audioFilename: string
  /**
   * [Events] 里声明的曲绘文件名。谱面没写就是空字符串。
   * 注意这只是个**文件名**，真正的图片要从压缩包里按这个名字取。
   */
  backgroundFilename: string
  /** [General] Mode。3 = mania，只有 mania 能用 */
  mode: number
  title: string
  artist: string
  /** 谱师 */
  creator: string
  /** 难度名 */
  version: string
  /** [Difficulty] CircleSize。mania 下就是键数 */
  circleSize: number
  /** [Difficulty] OverallDifficulty，第 4 步算判定窗口要用 */
  overallDifficulty: number
  timingPoints: OsuTimingPoint[]
  hitObjects: OsuHitObject[]
}

/**
 * 解析一个 `.osu` 文件的文本内容。
 *
 * @param text 文件内容（UTF-8 解码后的字符串）
 */
export function parseOsu(text: string): OsuBeatmap {
  // 有些文件带 UTF-8 BOM(字节序标记)，不剥掉的话第一行的键名会多出一个不可见字符，
  // 导致后面的正则匹配失败。
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  let formatVersion = 0
  const general = new Map<string, string>()
  const metadata = new Map<string, string>()
  const difficulty = new Map<string, string>()
  const timingPoints: OsuTimingPoint[] = []
  const hitObjects: OsuHitObject[] = []

  let section = ''
  let backgroundFilename = ''

  for (const rawLine of lines) {
    const line = rawLine.trim()
    // 跳过空行和注释行（osu 用 // 作为注释）
    if (line === '' || line.startsWith('//')) continue

    // 段头：[General] [Metadata] ...
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1)
      continue
    }

    // 文件首行形如 "osu file format v14"，既没有冒号也不在任何段内
    if (section === '') {
      const matched = /^osu file format v(\d+)/.exec(line)
      if (matched) formatVersion = Number(matched[1])
      continue
    }

    if (section === 'TimingPoints') {
      const point = parseTimingPoint(line)
      if (point) timingPoints.push(point)
      continue
    }

    if (section === 'HitObjects') {
      const object = parseHitObject(line)
      if (object) hitObjects.push(object)
      continue
    }

    if (section === 'Events') {
      // 一个谱面里可能有多条背景事件（改过谱面就会有），后写的生效
      const background = parseBackgroundEvent(line)
      if (background !== null) backgroundFilename = background
      continue
    }

    // 其余段都是 Key: Value。
    // 用「第一个冒号」切分而不是 split(':')，因为值里可能含冒号
    // （比如 AudioFilename 或长条的 hitSample 字段）。
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()

    if (section === 'General') general.set(key, value)
    else if (section === 'Metadata') metadata.set(key, value)
    else if (section === 'Difficulty') difficulty.set(key, value)
  }

  // osu 里时间点理论上是有序的，但排序一次成本极低。
  // Array.sort 是稳定排序，所以同一时刻的多个点会保持文件里的先后顺序。
  timingPoints.sort((a, b) => a.time - b.time)

  return {
    formatVersion,
    audioFilename: (general.get('AudioFilename') ?? '').trim(),
    backgroundFilename,
    // Mode 缺省时 osu 认为是 0（osu!std）。
    // 这里也用 0 作为缺省值，非 mania 的谱面会在后面被过滤掉。
    mode: toInt(general.get('Mode'), 0),
    title: metadata.get('Title') ?? '',
    artist: metadata.get('Artist') ?? '',
    creator: metadata.get('Creator') ?? '',
    version: metadata.get('Version') ?? '',
    // mania 的键数就存在 CircleSize 里。缺省给 4，正好是我们的主场景。
    circleSize: toNumber(difficulty.get('CircleSize'), 4),
    overallDifficulty: toNumber(difficulty.get('OverallDifficulty'), 5),
    timingPoints,
    hitObjects,
  }
}

/**
 * 解析 `[Events]` 里的一行「背景图」事件。
 *
 * 格式是 `0,0,"bg.jpg",0,0`（类型 0 = 背景图；类型 1 是视频，其它是 storyboard 指令）。
 *
 * ⚠️ 这里**不能**简单地 `split(',')` 取第 3 段 —— 文件名里完全可能带逗号
 * （比如 `"bg, night.jpg"`），那样会被切成两半。所以优先按引号取。
 * 引号形式取不到时再退回简单的分段写法（很老的谱面不写引号）。
 */
function parseBackgroundEvent(line: string): string | null {
  const quoted = /^0\s*,\s*0\s*,\s*"([^"]*)"/.exec(line)
  if (quoted !== null) {
    const name = quoted[1].trim()
    return name === '' ? null : name
  }

  // 没写引号的老格式：0,0,bg.jpg
  const parts = line.split(',')
  if (parts.length < 3) return null
  if (parts[0].trim() !== '0' || parts[1].trim() !== '0') return null
  const name = parts[2].trim().replace(/^"|"$/g, '')
  return name === '' ? null : name
}

/**
 * 解析一行 `[TimingPoints]`：
 *
 *   time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
 *   0   ,500       ,4    ,2        ,0          ,100   ,1          ,0
 */
function parseTimingPoint(line: string): OsuTimingPoint | null {
  const parts = line.split(',')
  if (parts.length < 2) return null

  const time = Number(parts[0])
  const beatLength = Number(parts[1])
  // beatLength 为 0 或非数字的点是无意义的，直接丢弃
  if (!Number.isFinite(time) || !Number.isFinite(beatLength) || beatLength === 0) return null

  // 第 7 列是 uninherited 标志。
  // 很老的 osu 文件格式（v3/v4）只有前两列，那时所有时间点都是 BPM 点。
  const uninherited = parts.length >= 7 ? parts[6].trim() !== '0' : true

  return { time, beatLength, uninherited }
}

/**
 * 解析一行 `[HitObjects]`：
 *
 *   x,y,time,type,hitSound,objectParams,hitSample
 *
 * mania 下：
 *   - type & 1   → 单点音符
 *   - type & 128 → 长条（Hold）
 *   - 长条的第 6 列是 `结束时间:hitSample...`，取第一个冒号之前的部分
 */
function parseHitObject(line: string): OsuHitObject | null {
  const parts = line.split(',')
  if (parts.length < 5) return null

  const x = Number(parts[0])
  const time = Number(parts[2])
  const type = Number(parts[3])
  if (!Number.isFinite(x) || !Number.isFinite(time) || !Number.isFinite(type)) return null

  const isHold = (type & 128) !== 0
  let endTime = time

  if (isHold && parts.length >= 6) {
    const parsed = Number(parts[5].split(':')[0])
    // 只有比起点晚才算合法长条；否则当作单点处理，避免出现零长度甚至负长度的音符
    if (Number.isFinite(parsed) && parsed > time) endTime = parsed
  }

  return { x, time, endTime, isHold }
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
