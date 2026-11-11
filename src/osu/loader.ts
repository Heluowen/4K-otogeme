import type { Chart, Note } from '../core/types'
import { isAudioFileName } from '../audio/decode'
import { parseOsuSmart } from './backend'
import type { OsuBeatmap } from './parser'
import { deriveBpmSegments, deriveSvSegments, type BpmSegment, type SvSegment } from './timing'
import { readZip, type ZipFiles } from './unzip'

/**
 * 组装层：把一个 `.osz` / `.zip` 文件字节，变成可以直接播放的谱面。
 *
 * 数据流：
 *   File → ArrayBuffer → readZip → 逐个 parseOsuSmart → 过滤 Mode 3 → OsuSet
 *                                                              ↓ 用户选一个难度
 *                              pickAudioBytes + decodeAudio → AudioBuffer
 *                              toChart                       → Chart
 *
 * 注意 `parseOsuSmart` 而不是 `parseOsu`：它会先探测 C 后端，
 * 能用就把 `.osu` 文本发给 C 解析，不能用就静默回落到内置解析器。
 * 对上层来说两者返回的是同一个类型，调用方不需要关心用的是哪个。
 */

/** 一个可玩的难度。 */
export interface OsuDifficulty {
  /** 难度名（[Metadata] Version）。空的话退回文件名，保证列表里每一项都有名字 */
  name: string
  /** 它在压缩包里的文件名 */
  fileName: string
  /** 键数。4K 就是 4 */
  keyCount: number
  /** 音符总数，列表里显示一下，方便判断难度 */
  noteCount: number
  /** 原始解析结果，toChart 用得到 */
  beatmap: OsuBeatmap
  /** BPM 分段，UI 显示当前 BPM 用 */
  bpmSegments: BpmSegment[]
  /** SV 分段。第 1–3 步只是解析出来存着，第 5 步才喂给 ScrollModel */
  svSegments: SvSegment[]
}

/** 一个压缩包解出来的全部内容。 */
export interface OsuSet {
  /** 压缩包文件名，用于界面显示 */
  sourceName: string
  /** 压缩包里的所有文件，找音频要用 */
  files: ZipFiles
  /** 里面所有 osu!mania 难度 */
  difficulties: OsuDifficulty[]
}

/**
 * 读取一个 `.osz` / `.zip`。
 *
 * @param sourceName 压缩包的文件名（仅用于显示）
 * @param buffer     压缩包的二进制内容
 */
export async function readOsuSet(sourceName: string, buffer: ArrayBuffer): Promise<OsuSet> {
  const files = await readZip(buffer)
  const decoder = new TextDecoder('utf-8')

  const difficulties: OsuDifficulty[] = []

  for (const [fileName, data] of files) {
    if (!fileName.toLowerCase().endsWith('.osu')) continue

    let beatmap: OsuBeatmap
    try {
      // 优先 C 后端；不可用/出错时内部自动回落到内置解析器，不会抛网络异常
      beatmap = await parseOsuSmart(decoder.decode(data))
    } catch {
      // 单个 .osu 坏了不应该让整个谱面包读不出来，跳过就好
      continue
    }

    // Mode: 3 才是 osu!mania。
    // 其它模式（0=std / 1=taiko / 2=catch）的 x,y 坐标语义完全不同，
    // 拿过来当轨道号用会得到完全错误的谱面，所以直接过滤掉。
    if (beatmap.mode !== 3) continue

    // CircleSize 就是 mania 的键数。正常范围 1..18（osu 支持 1K~18K，
    // 但我们只做 4K，其它键数也留着，UI 会标注出来）
    const keyCount = Math.round(beatmap.circleSize)
    if (keyCount < 1 || keyCount > 18) continue

    difficulties.push({
      name: beatmap.version.trim() || fileName.replace(/\.osu$/i, ''),
      fileName,
      keyCount,
      noteCount: beatmap.hitObjects.length,
      beatmap,
      bpmSegments: deriveBpmSegments(beatmap.timingPoints),
      svSegments: deriveSvSegments(beatmap.timingPoints),
    })
  }

  if (difficulties.length === 0) {
    // 给出能指导用户下一步的报错，而不是干巴巴的"加载失败"
    const hasAnyOsu = [...files.keys()].some((name) => name.toLowerCase().endsWith('.osu'))
    throw new Error(
      hasAnyOsu
        ? '这个压缩包里没有 osu!mania 谱面（只有 osu!std / taiko / catch）。请换成 mania 谱面。'
        : '这个压缩包里找不到任何 .osu 文件。请确认拖入的是 osu 谱面包（.osz）或包含 .osu 的 zip。',
    )
  }

  // 排序：先按键数（方便一眼找到 4K），再按音符数（近似难度）
  difficulties.sort((a, b) => a.keyCount - b.keyCount || a.noteCount - b.noteCount)

  return { sourceName, files, difficulties }
}

/** 图片扩展名 → MIME 类型。类型不对的话 `<img>` 会拒绝加载，所以必须给对。 */
const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  avif: 'image/avif',
}

/** 取图片的 MIME 类型；不是图片就返回 null。 */
export function imageMimeTypeOf(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return IMAGE_MIME_TYPES[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * 从压缩包里取出这个难度的曲绘。
 *
 * 和音频不同，这里**刻意不做"随便挑一张图"的兜底** ——
 * 一个谱面包里往往还有一堆 storyboard 用的图片，随手挑一张当曲绘只会更糟。
 * 谱面没声明曲绘、或者声明的那张找不到，就返回 null，界面显示"暂无消息"。
 */
export function pickBackgroundBytes(
  set: OsuSet,
  difficulty: OsuDifficulty,
): Uint8Array<ArrayBuffer> | null {
  return findFileByName(set.files, difficulty.beatmap.backgroundFilename, null)
}

/**
 * 从压缩包里取出这个难度对应的音频。
 *
 * @returns 音频字节；实在找不到返回 null，由 UI 提示用户手动指定。
 */
export function pickAudioBytes(
  set: OsuSet,
  difficulty: OsuDifficulty,
): Uint8Array<ArrayBuffer> | null {
  return findFileByName(set.files, difficulty.beatmap.audioFilename, isAudioFileName)
}

/**
 * 在压缩包里按名字找文件，三级兜底：
 *   ① 完整路径精确匹配（大小写不敏感）
 *   ② 只比文件名，忽略 zip 里的子目录层级
 *   ③ 交给调用方按后缀兜底（音频用得上；曲绘故意不用，见 pickBackgroundBytes）
 *
 * 现实里谱面写的名字经常对不上（多了子目录、大小写不一致、URL 编码），
 * 所以前两级都需要。
 */
function findFileByName(
  files: ZipFiles,
  wantedName: string,
  fallbackMatcher: ((name: string) => boolean) | null,
): Uint8Array<ArrayBuffer> | null {
  const wanted = normalizePath(wantedName)

  if (wanted !== '') {
    for (const [name, data] of files) {
      if (normalizePath(name) === wanted) return data
    }

    const wantedBase = baseName(wanted)
    for (const [name, data] of files) {
      if (baseName(normalizePath(name)) === wantedBase) return data
    }
  }

  if (fallbackMatcher !== null) {
    for (const [name, data] of files) {
      if (fallbackMatcher(name)) return data
    }
  }

  return null
}

/**
 * 把解析结果折算成引擎用的 `Chart`。
 *
 * 这一步之后，整个引擎就再也不知道 BPM、SV、CircleSize 这些东西了，
 * 它面对的只有「第几轨、第几毫秒」。
 */
export function toChart(difficulty: OsuDifficulty): Chart {
  const { beatmap, keyCount } = difficulty

  const notes: Note[] = beatmap.hitObjects.map((object) => ({
    // osu 的 x 坐标范围固定是 0..512，把这段区间均匀切成 keyCount 份就是轨道号。
    // 4K 时 x 通常是 64 / 192 / 320 / 448，算出来正好 0 / 1 / 2 / 3。
    // 夹紧是为了防御少数谱面里越界的 x 值，避免出现负的或超出的轨道号。
    column: Math.min(keyCount - 1, Math.max(0, Math.floor((object.x * keyCount) / 512))),
    time: object.time,
    endTime: object.endTime,
  }))

  // 渲染时依赖「按时间升序」做提前退出，而 .osu 里 hitObjects 的顺序不保证有序
  // （尤其是经过编辑器多次修改的谱面）。
  notes.sort((a, b) => a.time - b.time)

  return {
    meta: {
      title: beatmap.title,
      artist: beatmap.artist,
      creator: beatmap.creator,
      version: difficulty.name,
      audioFilename: beatmap.audioFilename,
      overallDifficulty: beatmap.overallDifficulty,
    },
    keyCount,
    notes,
    // osu 的 SV 分段直接在解析阶段就换算成了「倍率」，
    // 这里原样交给核心 —— 核心不知道 osu 的 beatLength 为负那套约定。
    // SvSegment 的结构（time + multiplier）和 SpeedMultiplierPoint 完全一致，
    // 所以不需要再做一次映射。
    speedPoints: difficulty.svSegments,
  }
}

/** 统一路径写法：反斜杠转正斜杠、URL 解码、转小写，方便做大小写不敏感比较。 */
function normalizePath(path: string): string {
  let result = path.trim().replace(/\\/g, '/')
  // osu 有时会把文件名写成 URL 编码（中文尤其常见，比如 %E4%B8%AD.mp3）
  try {
    result = decodeURIComponent(result)
  } catch {
    // 编码格式不对就原样使用
  }
  return result.toLowerCase()
}

/** 取路径的最后一段（文件名部分）。 */
function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}
