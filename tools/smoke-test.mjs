/**
 * 冒烟测试：不依赖浏览器，直接验证「二进制解析」这条最容易出错、又最难手测的链路。
 *
 *   zip 字节
 *     → readZip      解压、列文件、还原字节
 *     → parseOsu     解析 [General] / [Difficulty] / [TimingPoints] / [HitObjects]
 *     → timing.ts    BPM 分段、SV 倍率换算
 *
 * Node 从 22.6 起原生支持直接执行 TypeScript（只做类型擦除，不做类型检查），
 * 所以这个脚本能直接 import 项目的 .ts 源码，不需要任何构建步骤。
 *
 * 关于测试数据：默认由本脚本用 zlib 现场造一个 zip。
 * 如果 `tools/fixture.osz` 存在（可以用 tools/make-fixture.ps1 生成），
 * 就优先用它 —— 那是 .NET 的 zip 写入器产出的，"别的工具做的 zip"能更好地
 * 验证我们的读取器不是在自说自话。
 *
 * 用法：npm test
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

import { readZip } from '../src/osu/unzip.ts'
import { parseOsu } from '../src/osu/parser.ts'
import { deriveBpmSegments, deriveSvSegments } from '../src/osu/timing.ts'
import { fullComboAnimation, FULL_COMBO_DURATION_MS } from '../src/core/celebration.ts'
import { countdownTick } from '../src/core/countdown.ts'
import {
  computePlayfieldWidth,
  DEFAULT_NOTE_SIZE_LEVEL,
  depthScale,
  MAX_LANE_WIDTH,
  MAX_NOTE_SIZE_LEVEL,
  MAX_TILT_DEGREES,
  MIN_NOTE_SIZE_LEVEL,
  noteSizePreset,
  scaleAtScreenY,
  screenRatio,
  tiltStrengthFromDegrees,
} from '../src/core/fall-style.ts'
import {
  Grade,
  GRADE_LABELS,
  Judge,
  NOTE_HOLDING,
  NOTE_PENDING,
  NOTE_RESOLVED,
  windowsFromOverallDifficulty,
} from '../src/core/judge.ts'
import {
  clearCachedSets,
  deleteCachedSet,
  listCachedSets,
  planEviction,
  readCachedSet,
  saveCachedSet,
} from '../src/store/chart-cache.ts'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
let passes = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (ok) passes++
  else failures++
  const shown = JSON.stringify(actual)
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? ` = ${shown}` : ` → ${shown}（期望 ${JSON.stringify(expected)}）`}`)
}

/**
 * 浮点比较版本。
 *
 * 缓动函数里的加减乘除必然带舍入误差 —— 比如 easeOutBack(0) 在浮点下会算出
 * 2e-16 而不是 0，于是 0.35 + 0.65 * 那个值 得到 0.35000000000000014。
 * 视觉上毫无区别，但 Object.is 会判它不相等。所以要比较浮点就必须带容差。
 */
function checkClose(label, actual, expected, epsilon = 1e-9) {
  const ok = Math.abs(actual - expected) < epsilon
  if (ok) passes++
  else failures++
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? ` ≈ ${actual}` : ` → ${actual}（期望 ≈ ${expected}）`}`,
  )
}

// ---------------------------------------------------------------------------
// 0. 准备测试数据
// ---------------------------------------------------------------------------

/** 假音频的长度。内容由下面的公式决定，测试会重算一遍做逐字节比对。 */
const AUDIO_SIZE = 3000
/** 假音频第 i 个字节的值 */
const audioByteAt = (i) => (i * 37 + 11) % 256

const CHART_OSU = `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title:Smoke Test
Artist:Tester
Creator:rhythm-4k
Version:4K Test

[Difficulty]
CircleSize:4
OverallDifficulty:8

[Events]
//Background and Video events
0,0,"bg, night.jpg",0,0
1,0,"video.avi",0,0
//Break Periods
2,5000,8000

[TimingPoints]
0,500,4,2,0,100,1,0
1200,-50,4,2,0,100,0,0
2400,-200,4,2,0,100,0,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
192,192,1250,1,0,0:0:0:0:
320,192,1500,128,0,2000:0:0:0:0:
448,192,1750,1,0,0:0:0:0:
`

const audioBytes = new Uint8Array(AUDIO_SIZE)
for (let i = 0; i < AUDIO_SIZE; i++) audioBytes[i] = audioByteAt(i)

const externalOsz = join(here, 'fixture.osz')

let zipBuffer
if (existsSync(externalOsz)) {
  console.log('[0] 使用 tools/fixture.osz（由 PowerShell 的 Compress-Archive 生成的真实 zip）')
  const raw = readFileSync(externalOsz)
  // Buffer 的 .buffer 往往是 Node 内部共享的内存池，必须按 byteOffset 切出这一段
  zipBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
} else {
  console.log('[0] 未找到 tools/fixture.osz，用 zlib 现场生成一个同样走 deflate 路径的 zip')
  zipBuffer = buildZip([
    { name: 'chart.osu', data: new TextEncoder().encode(CHART_OSU) },
    { name: 'audio.mp3', data: audioBytes },
  ])
}

// ---------------------------------------------------------------------------
// 1. 读 zip
// ---------------------------------------------------------------------------

const files = await readZip(zipBuffer)
console.log(`\n[1] ZIP 解包 —— 条目: ${[...files.keys()].join(', ')}`)
check('条目数量', files.size, 2)
check('含有 chart.osu', files.has('chart.osu'), true)
check('含有 audio.mp3', files.has('audio.mp3'), true)

// 逐字节比对：确认 inflate 真的还原了原始内容，而不只是还原了长度。
// 只比长度的话，解压出一堆垃圾数据也能蒙混过关。
const audio = files.get('audio.mp3')
check('audio.mp3 长度', audio.length, AUDIO_SIZE)

let firstMismatch = -1
for (let i = 0; i < Math.min(AUDIO_SIZE, audio.length); i++) {
  if (audio[i] !== audioByteAt(i)) {
    firstMismatch = i
    break
  }
}
check('audio.mp3 内容逐字节一致（-1 表示全对）', firstMismatch, -1)

// ---------------------------------------------------------------------------
// 2. 解析 .osu
// ---------------------------------------------------------------------------

const text = new TextDecoder('utf-8').decode(files.get('chart.osu'))
const beatmap = parseOsu(text)
console.log('\n[2] .osu 解析')
check('格式版本', beatmap.formatVersion, 14)
check('AudioFilename', beatmap.audioFilename, 'audio.mp3')
check('Mode（3 = mania）', beatmap.mode, 3)
check('CircleSize（即键数）', beatmap.circleSize, 4)
check('OverallDifficulty', beatmap.overallDifficulty, 8)
check('Title', beatmap.title, 'Smoke Test')
check('Artist', beatmap.artist, 'Tester')
check('Creator', beatmap.creator, 'rhythm-4k')
check('Version', beatmap.version, '4K Test')

// 曲绘来自 [Events] 段。这里刻意用了**带逗号的文件名** ——
// 用 split(',') 取第三段的话会得到 "bg"，正好能测出这个经典错误。
check('曲绘文件名（含逗号也不能被切断）', beatmap.backgroundFilename, 'bg, night.jpg')

// 曲绘解析的边界情况：没有 [Events] 段、以及很老的不带引号写法
check(
  '没有 [Events] 段时曲绘为空字符串',
  parseOsu('osu file format v14\n\n[General]\nMode: 3\n').backgroundFilename,
  '',
)
check(
  '老格式（文件名不带引号）也能解析',
  parseOsu('osu file format v14\n\n[Events]\n0,0,bg.jpg\n').backgroundFilename,
  'bg.jpg',
)
// storyboard 指令和 break 段都不能被误当成背景
check(
  '非背景事件不会被误判',
  parseOsu(
    'osu file format v14\n\n[Events]\n2,5000,8000\n1,0,"video.avi"\n',
  ).backgroundFilename,
  '',
)
// 多条背景事件时后写的生效（谱面被改过就会有这种情况）
check(
  '多条背景事件时最后一条生效',
  parseOsu('osu file format v14\n\n[Events]\n0,0,"first.png"\n0,0,"second.png"\n')
    .backgroundFilename,
  'second.png',
)

check('TimingPoints 条数', beatmap.timingPoints.length, 3)
check('第 1 个点是 BPM 点', beatmap.timingPoints[0].uninherited, true)
check('第 1 个点 beatLength', beatmap.timingPoints[0].beatLength, 500)
check('第 2 个点是 SV 点', beatmap.timingPoints[1].uninherited, false)
check('第 3 个点是 SV 点', beatmap.timingPoints[2].uninherited, false)
check('TimingPoints 已按时间排序', beatmap.timingPoints.map((p) => p.time).join(','), '0,1200,2400')

check('HitObjects 条数', beatmap.hitObjects.length, 4)
check('第 1 个音符时间', beatmap.hitObjects[0].time, 1000)
check('第 1 个音符 x', beatmap.hitObjects[0].x, 64)
check('第 3 个音符是长条', beatmap.hitObjects[2].isHold, true)
// 长条的结束时间藏在第 6 列的 "2000:0:0:0:0" 里
check('第 3 个音符结束时间', beatmap.hitObjects[2].endTime, 2000)
check('第 4 个音符是单点', beatmap.hitObjects[3].isHold, false)
check('单点的 endTime 等于 time', beatmap.hitObjects[3].endTime, beatmap.hitObjects[3].time)

// ---------------------------------------------------------------------------
// 3. 轨道号换算 + BPM/SV 折算
// ---------------------------------------------------------------------------

// 这段公式和 src/osu/loader.ts 的 toChart() 保持一致
const columns = beatmap.hitObjects.map((o) =>
  Math.min(beatmap.circleSize - 1, Math.max(0, Math.floor((o.x * beatmap.circleSize) / 512))),
)
console.log('\n[3] 轨道号与变速')
check('轨道号（x=64/192/320/448 → 0/1/2/3）', columns.join(','), '0,1,2,3')

const bpmSegments = deriveBpmSegments(beatmap.timingPoints)
check('BPM 分段条数（只有 BPM 点会进来）', bpmSegments.length, 1)
check('BPM 值（60000 / 500）', bpmSegments[0].bpm, 120)

const svSegments = deriveSvSegments(beatmap.timingPoints)
check('SV 分段条数（只有 SV 点会进来）', svSegments.length, 2)
// beatLength =  -50 → -100 / -50  = 2.0
// beatLength = -200 → -100 / -200 = 0.5
check('SV 倍率 1（beatLength -50）', svSegments[0].multiplier, 2)
check('SV 倍率 2（beatLength -200）', svSegments[1].multiplier, 0.5)
check('SV 生效时刻', svSegments.map((s) => s.time).join(','), '1200,2400')

// ---------------------------------------------------------------------------
// 4. 判定引擎
// ---------------------------------------------------------------------------

// 判定是纯逻辑，不碰浏览器 —— 所以能在 Node 里直接测，
// 而且必须测：它是整个项目里状态最复杂、最容易写错的一环。

const windows = windowsFromOverallDifficulty(8)
console.log('\n[4] 判定引擎')
// OD8 时代入公式：300 = 64-24 = 40，200 = 97-24 = 73，100 = 127-24 = 103，
// 50 = 151-24 = 127，miss = 188-24 = 164；MAX 固定 16
check('MAX 窗口', windows.max, 16)
check('300 窗口', windows.g300, 40)
check('200 窗口', windows.g200, 73)
check('100 窗口', windows.g100, 103)
check('50 窗口', windows.g50, 127)
check('Miss 窗口', windows.miss, 164)

/** 造一个最小可用的 Chart，只填判定需要用到的那几个字段 */
function chartOf(notes, overallDifficulty = 8) {
  return {
    meta: {
      title: '',
      artist: '',
      creator: '',
      version: '',
      audioFilename: '',
      overallDifficulty,
    },
    keyCount: 4,
    notes,
    speedPoints: [],
  }
}

// ---- 单点音符：偏差 → 评级 ----
{
  const cases = [
    [5, Grade.Max],
    [30, Grade.G300],
    [60, Grade.G200],
    [90, Grade.G100],
    [120, Grade.G50],
    [150, Grade.Miss],
  ]
  for (const [offset, expected] of cases) {
    const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 1000 }]))
    // 音符在 1000ms，把按下时刻提前 offset 毫秒，偏差就是 +offset
    judge.press(0, 1000 - offset)
    const stats = judge.stats
    check(`偏差 ${offset}ms 的评级（应为 ${GRADE_LABELS[expected]}）`, stats.counts[expected], 1)
  }
}

// ---- 连击与断连 ----
{
  const judge = new Judge(
    chartOf([
      { column: 0, time: 1000, endTime: 1000 },
      { column: 1, time: 1200, endTime: 1200 },
      { column: 2, time: 1400, endTime: 1400 },
    ]),
  )
  judge.press(0, 1000)
  judge.press(1, 1200)
  check('两次命中后的连击', judge.stats.combo, 2)

  // 第三个音符按得太晚（偏差 150ms），应当判 Miss 并断连
  judge.press(2, 1400 + 150)
  check('Miss 之后连击归零', judge.stats.combo, 0)
  check('最大连击被保留', judge.stats.maxCombo, 2)
}

// ---- 空敲不断连 ----
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 1000 }]))
  judge.press(0, 1000)
  // 第 2 轨附近没有任何音符 → 空敲
  judge.press(1, 1000)
  judge.press(1, 1500)
  const stats = judge.stats
  check('空敲被计数', stats.ghostTaps, 2)
  check('空敲不影响连击', stats.combo, 1)
}

// ---- 长条：一直按到结尾 ----
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 3000 }]))
  judge.press(0, 1000)
  check('长条头部命中时还不结算（等待尾部）', judge.stats.judged, 0)

  judge.update(3000)
  const stats = judge.stats
  check('按到结尾后结算为 MAX', stats.counts[Grade.Max], 1)
  check('长条计入连击', stats.combo, 1)
}

// ---- 长条：松手太早 ----
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 3000 }]))
  judge.press(0, 1000)
  // 提前 1000ms 松手，远超 miss 窗口（164ms）→ 整条断掉
  judge.release(0, 2000)
  const stats = judge.stats
  check('提前松手判 Miss', stats.counts[Grade.Miss], 1)
  check('提前松手断连', stats.combo, 0)
}

// ---- 长条：只提前一点点松手 ----
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 3000 }]))
  judge.press(0, 1000)
  // 提前 10ms 松手，落在 MAX 窗口内
  judge.release(0, 2990)
  const stats = judge.stats
  check('提前 10ms 松手仍为 MAX', stats.counts[Grade.Max], 1)
}

// ---- 过了窗口没按 → 自动 Miss ----
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 1000 }]))
  // 判定引擎扫描过期音符时会留 INPUT_GRACE_MS(50ms) 的输入宽限，
  // 所以要把时间推过 miss 窗口 + 宽限才会自动判 Miss
  judge.update(1000 + 164 + 50 + 1)
  check('没过线就自动 Miss', judge.stats.counts[Grade.Miss], 1)
}

// ---- 分数与准确率 ----
{
  const judge = new Judge(
    chartOf([
      { column: 0, time: 1000, endTime: 1000 },
      { column: 1, time: 1200, endTime: 1200 },
    ]),
  )
  judge.press(0, 1000) // MAX
  judge.press(1, 1200 - 60) // 200
  const stats = judge.stats
  // 权重 (300 + 200) / (2 * 300) = 0.8333...
  check('准确率（(300+200)/600）', stats.accuracy.toFixed(4), '0.8333')
  check('分数（准确率 × 1000000）', stats.score, 833333)
}

// ---- 带符号偏差统计（延迟校准的输入） ----
{
  const judge = new Judge(
    chartOf([
      { column: 0, time: 1000, endTime: 1000 },
      { column: 1, time: 1200, endTime: 1200 },
    ]),
  )
  // 两次都晚打 20ms：offset = 音符时间 - 命中时间 = -20
  judge.press(0, 1020)
  judge.press(1, 1220)
  const stats = judge.stats
  check('偏差样本数', stats.meanOffsetSamples, 2)
  check('平均带符号偏差（晚打 20ms → -20）', stats.meanOffsetMs, -20)
}

// ---- 同轨连打必须按时间顺序消费，不能挑"偏差最小"的那个 ----
{
  const judge = new Judge(
    chartOf([
      { column: 0, time: 1000, endTime: 1000 },
      { column: 0, time: 1100, endTime: 1100 },
    ]),
  )
  // 在 1060 按下：第一个音符偏差 -60（200 档），第二个偏差 +40（MAX 档）。
  // 两者都在窗口内，但必须判给**先到的那个** —— 音游不允许跳音符。
  judge.press(0, 1060)
  const afterFirst = judge.stats
  check('同轨连打判给先到的音符（200 而不是 MAX）', afterFirst.counts[Grade.G200], 1)
  check('后面的音符没有被消费掉', afterFirst.judged, 1)

  judge.press(0, 1100)
  const afterSecond = judge.stats
  check('第二次按下才轮到第二个音符', afterSecond.judged, 2)
  check('第二次判决为 MAX', afterSecond.counts[Grade.Max], 1)
}

// ---- 输入宽限区间里的过期音符，不能吃掉后续按键 ----
{
  const judge = new Judge(
    chartOf([
      { column: 0, time: 1000, endTime: 1000 },
      { column: 0, time: 1250, endTime: 1250 },
    ]),
  )
  // 1000 那个音符从没被按过。到 1180 时它已经超出判定窗口，
  // 但因为扫描会额外等 INPUT_GRACE_MS(50ms)，它此刻还是 Pending 状态。
  // 玩家这一下按的其实是 1250 那个音符（偏差 +70）。
  judge.press(0, 1180)
  const stats = judge.stats
  check('宽限期内的过期音符没有被算成命中', stats.counts[Grade.G200], 1)
  check('该按键没有被过期音符吃掉', stats.ghostTaps, 0)
}

// ---- 全部判完的标记 ----
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 1000 }]))
  check('未判定时 finished 为 false', judge.stats.finished, false)
  judge.press(0, 1000)
  check('全部判完后 finished 为 true', judge.stats.finished, true)
}

// ---- 状态表（渲染层靠它跳过已判音符） ----
//
// 暂停恢复时画面会倒带几秒，渲染层必须跳过已经判完的音符，
// 否则打过的东西会重新落一遍、看起来像在重打。
//
// 这里最关键的是长条：头部命中之后状态是 HOLDING 而**不是** RESOLVED ——
// 渲染层只跳过 RESOLVED，假如长条被提前标成已判完，按住的时候它就会整个消失。

check('三种状态互不相同', new Set([NOTE_PENDING, NOTE_HOLDING, NOTE_RESOLVED]).size, 3)

// ---- 偏差的符号约定 ----
//
// 全局约定：**正数 = 打早（FAST），负数 = 打晚（LATE）**，
// 单点音符和长条收尾都必须遵守。这条一旦不一致：
//   - 延迟校准的平均值会被长条样本往反方向拉
//   - 界面上的 FAST / LATE 提示会显示反
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 1000 }]))
  judge.press(0, 980) // 早打 20ms
  check('单点：早打 → 偏差为正', judge.recentFeedbacks[0].offsetMs > 0, true)
}
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 1000 }]))
  judge.press(0, 1020) // 晚打 20ms
  check('单点：晚打 → 偏差为负', judge.recentFeedbacks[0].offsetMs < 0, true)
}
{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 3000 }]))
  judge.press(0, 1000)
  judge.release(0, 2980) // 早松手 20ms
  check('长条：早松手 → 平均偏差为正（和单点一致）', judge.stats.meanOffsetMs > 0, true)

  // 收尾这一次必须也推送到反馈列表 —— 界面只显示最近一条，
  // 不推的话长条松手打得好不好就永远看不到了
  const tail = judge.recentFeedbacks[judge.recentFeedbacks.length - 1]
  check('长条收尾的结果也会推送到反馈列表', tail !== undefined && tail.offsetMs > 0, true)
  check('推送的是收尾那一条', tail.isHoldTail, true)
}
{
  const judge = new Judge(
    chartOf([
      { column: 0, time: 1000, endTime: 1000 },
      { column: 0, time: 1100, endTime: 3100 },
    ]),
  )
  judge.press(0, 1000) // 单点正中
  judge.release(0, 3000) // 长条正中
  check('两种音符都打准时平均偏差接近 0', Math.abs(judge.stats.meanOffsetMs) < 1e-9, true)
}

{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 1000 }]))
  check('未判定时状态是 PENDING', judge.noteStates[0], NOTE_PENDING)
  judge.press(0, 1000)
  check('单点音符判定后变成 RESOLVED', judge.noteStates[0], NOTE_RESOLVED)
}

{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 3000 }]))
  judge.press(0, 1000)
  check('长条头部命中后是 HOLDING（不能被当成已判完）', judge.noteStates[0], NOTE_HOLDING)
  judge.update(3000)
  check('长条按到结尾结算后才变成 RESOLVED', judge.noteStates[0], NOTE_RESOLVED)
}

{
  const judge = new Judge(chartOf([{ column: 0, time: 1000, endTime: 3000 }]))
  judge.press(0, 1000)
  judge.release(0, 1500)
  check('长条提前松手后立刻变成 RESOLVED（画面应当马上消失）', judge.noteStates[0], NOTE_RESOLVED)
}

// ---------------------------------------------------------------------------
// 5. 缓存淘汰策略
// ---------------------------------------------------------------------------

// IndexedDB 本身在 Node 里没有，但淘汰策略被抽成了纯函数，可以单独验证。
// 这是缓存模块里唯一有分支逻辑的地方，也正是最容易写错的地方。

console.log('\n[5] 缓存淘汰策略')

/** 造一条缓存元信息 */
const cached = (name, size, savedAt) => ({ name, size, savedAt })

// 两条预算都没超 → 一个都不删
check(
  '未超限时不淘汰',
  planEviction([cached('a', 100, 1), cached('b', 100, 2)], 1000, 10).length,
  0,
)

// 条目数超了 → 从最旧的开始删（列表按 savedAt 升序）
check(
  '超出条目上限时删最旧的',
  planEviction([cached('a', 1, 1), cached('b', 1, 2), cached('c', 1, 3)], 1000, 2).join(','),
  'a',
)

// 字节数超了 → 删到进预算为止。三条各 100 字节，预算 250，删掉最旧的一条后剩 200 即可
check(
  '超出字节预算时删最旧的',
  planEviction([cached('a', 100, 1), cached('b', 100, 2), cached('c', 100, 3)], 250, 10).join(','),
  'a',
)

// 预算比单条还小 → 全部淘汰（否则会永远卡在超预算状态）
check(
  '预算小于单条大小时全部淘汰',
  planEviction([cached('a', 100, 1), cached('b', 100, 2)], 50, 10).length,
  2,
)

check('空列表不淘汰', planEviction([], 1000, 10).length, 0)

check(
  '刚好等于上限时不淘汰',
  planEviction([cached('a', 100, 1), cached('b', 100, 2)], 200, 2).length,
  0,
)

// ---------------------------------------------------------------------------
// 6. 索引缓存往返（fake-indexeddb）
// ---------------------------------------------------------------------------

// Node 本身没有 IndexedDB，所以用 fake-indexeddb 顶上一个符合规范的实现，
// 把「打开库 → 建表 → 写入 → 读回 → 覆盖 → 删除 → 清空」整条链路真正跑一遍。
//
// 这一步是必要的：光靠类型检查发现不了 IndexedDB 的事务陷阱 ——
// 比如「await 之后事务会自动提交、后续请求全部失败」这种问题，
// 只有真的执行一遍才会暴露。
//
// 注意赋值必须发生在调用任何缓存函数之前（模块顶层的 import 会先执行，
// 但 chart-cache.ts 在模块作用域里不碰 indexedDB，所以这里赋值来得及）。
globalThis.indexedDB = fakeIndexedDB

console.log('\n[6] 索引缓存往返（fake-indexeddb）')

const CACHE_BYTES = 2048
const cacheByteAt = (i) => (i * 7 + 3) % 256
const cachePayload = new Uint8Array(CACHE_BYTES)
for (let i = 0; i < CACHE_BYTES; i++) cachePayload[i] = cacheByteAt(i)

check('写入返回 true', await saveCachedSet('alpha.osz', cachePayload.buffer), true)

const listed = await listCachedSets()
check('列表长度', listed.length, 1)
check('文件名', listed[0]?.name, 'alpha.osz')
check('记录的字节数', listed[0]?.size, CACHE_BYTES)

const loadedSet = await readCachedSet('alpha.osz')
check('能读回条目', loadedSet !== null, true)

const loadedBytes = new Uint8Array(loadedSet?.data ?? new ArrayBuffer(0))
check('读回的字节数', loadedBytes.length, CACHE_BYTES)

// ArrayBuffer 经过结构化克隆之后必须逐字节一致
let cacheMismatch = -1
for (let i = 0; i < loadedBytes.length; i++) {
  if (loadedBytes[i] !== cacheByteAt(i)) {
    cacheMismatch = i
    break
  }
}
check('字节内容逐字节一致（-1 表示全对）', cacheMismatch, -1)

// 同名再写一次应当是覆盖，而不是新增一条
await saveCachedSet('alpha.osz', cachePayload.buffer)
check('同名写入是覆盖', (await listCachedSets()).length, 1)

// 再存一条；列表应按导入时间升序（最旧的在前）
await saveCachedSet('beta.osz', cachePayload.buffer)
check(
  '列表按导入时间升序',
  (await listCachedSets()).map((item) => item.name).join(','),
  'alpha.osz,beta.osz',
)

check('读不存在的条目返回 null', await readCachedSet('nope.osz'), null)

await deleteCachedSet('alpha.osz')
check('删除后列表', (await listCachedSets()).map((item) => item.name).join(','), 'beta.osz')
check('删除后读不到', await readCachedSet('alpha.osz'), null)

check('空文件名被拒绝', await saveCachedSet('', cachePayload.buffer), false)

await clearCachedSets()
check('清空后为空', (await listCachedSets()).length, 0)

// ---------------------------------------------------------------------------
// 7. 样式兜底（hidden 属性）
// ---------------------------------------------------------------------------

// 这条规则本身很简单，但它防的是一个非常隐蔽、且完全不报错的问题：
//
//   HTML 的 hidden 属性是靠浏览器**默认样式表**里的 `[hidden] { display: none }`
//   生效的。而作者样式表的优先级永远高于默认样式表 —— 只要别处随手写了
//   `.overlay { display: flex }`，hidden 就彻底失效，页面会同时显示所有面板。
//
// 这个项目里界面切换（导入 / 选难度 / 播放 / 设置 / 结算）全靠 hidden，
// 所以必须有一条 !important 兜底。
//
// 注意：这不是渲染测试（Node 里没有 CSS 引擎），只是一条护栏 ——
// 谁把这条兜底删了、或者漏了 !important，下面这项会立刻变红。

console.log('\n[7] 样式兜底')

const globalCss = readFileSync(join(here, '..', 'src', 'style.css'), 'utf8')
check(
  'style.css 里有 [hidden] 兜底，且带 !important',
  /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i.test(globalCss),
  true,
)

// 顺带确认 index.html 确实用了 hidden 属性做界面切换 ——
// 如果哪天改成别的机制了，上面那条的结果就没有意义，这里会提醒
const pageHtml = readFileSync(join(here, '..', 'index.html'), 'utf8')
check(
  'index.html 仍在用 hidden 属性切换面板',
  (pageHtml.match(/\bhidden\b/g) ?? []).length >= 4,
  true,
)

// ---------------------------------------------------------------------------
// 8. 准备倒计时的进位
// ---------------------------------------------------------------------------

// 这段最容易差一位：典型症状是「3 跳到 2 的瞬间闪一下 1」。
// 肉眼很难复现，但玩起来很别扭，所以把边界值一个个钉死。

console.log('\n[8] 准备倒计时进位')

check('剩 3000ms 显示 3', countdownTick(3000).seconds, 3)
check('剩 3000ms 时这一拍刚开始', countdownTick(3000).progress, 0)
check('剩 2500ms 还是 3', countdownTick(2500).seconds, 3)
check('剩 2500ms 时这一拍过半', countdownTick(2500).progress, 0.5)
// 刚跨过 2000 时仍然是 3，而且这一拍已经快走完
check('剩 2000.001ms 仍是 3', countdownTick(2000.001).seconds, 3)
check('剩 2000.001ms 时这一拍快走完', countdownTick(2000.001).progress > 0.999, true)
// 正好到 2000 才进位到 2，而且新的一拍必须从 0 开始（这就是"闪一下 1"的来源）
check('剩 2000ms 进位为 2', countdownTick(2000).seconds, 2)
check('剩 2000ms 时新的一拍从 0 开始', countdownTick(2000).progress, 0)
check('剩 1000ms 进位为 1', countdownTick(1000).seconds, 1)
check('剩 1000ms 时新的一拍从 0 开始', countdownTick(1000).progress, 0)
check('剩 500ms 还是 1', countdownTick(500).seconds, 1)
check('剩 1ms 仍是 1（不会跳到 0）', countdownTick(1).seconds, 1)

// progress 必须恒定落在 [0, 1]，否则画面上的缩放和透明度会跑到异常值
let badTicks = 0
for (let ms = 1; ms <= 3000; ms += 7) {
  const tick = countdownTick(ms)
  if (tick.progress < 0 || tick.progress > 1) badTicks++
  if (tick.seconds < 1 || tick.seconds > 3) badTicks++
}
check('全程 seconds 与 progress 都在合法范围内', badTicks, 0)

// ---------------------------------------------------------------------------
// 9. 全连击庆祝动画
// ---------------------------------------------------------------------------

// 时间曲线最容易错的是"什么时候该出现、什么时候该消失"，所以边界值全部钉死。

console.log('\n[9] 全连击庆祝动画')

check('还没达成时不显示', fullComboAnimation(-1).visible, false)
check('超出动画时长后不再显示', fullComboAnimation(FULL_COMBO_DURATION_MS + 1).visible, false)
check('时间戳是 NaN 时安全返回', fullComboAnimation(Number.NaN).visible, false)

const firstFrame = fullComboAnimation(0)
check('第 0ms 就开始显示', firstFrame.visible, true)
checkClose('文字从 0.35 倍开始放大', firstFrame.scale, 0.35)
check('第 0ms 完全透明（90ms 内快速淡入）', firstFrame.alpha, 0)
check('第 0ms 闪光最强', firstFrame.flash, 1)
check('第 0ms 横幅还没展开', firstFrame.bandProgress, 0)

check('入场结束时正好放大到 1 倍', fullComboAnimation(340).scale, 1)
check('闪光在 170ms 后完全消失', fullComboAnimation(170).flash, 0)
check('横幅在 420ms 内展开完', fullComboAnimation(420).bandProgress, 1)
check('中段完全不透明', fullComboAnimation(1300).alpha, 1)
check('动画末尾淡出到 0', fullComboAnimation(FULL_COMBO_DURATION_MS).alpha, 0)

// 全程扫一遍，确保没有任何一帧会算出离谱的数值
let badFrames = 0
let peakScale = 0
for (let ms = 0; ms <= FULL_COMBO_DURATION_MS; ms += 10) {
  const frame = fullComboAnimation(ms)
  if (!frame.visible) badFrames++
  if (!(frame.alpha >= 0 && frame.alpha <= 1)) badFrames++
  if (!(frame.flash >= 0 && frame.flash <= 1)) badFrames++
  if (!(frame.bandProgress >= 0 && frame.bandProgress <= 1)) badFrames++
  if (!(frame.scale > 0 && frame.scale < 1.2)) badFrames++
  if (frame.scale > peakScale) peakScale = frame.scale
}
check('全程各数值都在合法范围内', badFrames, 0)
// 回弹缓动必须真的冲过 1 倍，否则说明退化成线性放大了
check('峰值确实冲过了 1 倍（回弹生效）', peakScale > 1, true)

// ---------------------------------------------------------------------------
// 10. 下落样式（透视倾斜）
// ---------------------------------------------------------------------------

console.log('\n[10] 下落样式（透视倾斜）')

check('角度上限常量是 80', MAX_TILT_DEGREES, 80)

// ---- 0° 必须退化成完全正交，也就是原来的垂直下落 ----
check('0° 时透视强度为 0', tiltStrengthFromDegrees(0), 0)
check('0° 时任何深度都不缩放', depthScale(0, 0.5), 1)
checkClose('0° 时竖直位置就是线性', screenRatio(0, 0.25), 0.75)
checkClose('0° 时顶端仍是最远端的线性位置', screenRatio(0, 1), 0)

// ---- 端点：depth = 0 必须精确落在判定线上 ----
// 这是整个倾斜功能不影响判定的保证。任何一个角度下偏了，
// 音符看起来就不压在判定线上，手感直接毁掉。
for (const degrees of [0, 5, 20, 40, 60, 80]) {
  const strength = tiltStrengthFromDegrees(degrees)
  checkClose(`${degrees}° 时判定线处不缩放`, depthScale(strength, 0), 1)
  checkClose(`${degrees}° 时深度 0 精确落在判定线上`, screenRatio(strength, 0), 1)
  checkClose(`${degrees}° 时最远处正好在画面顶端`, screenRatio(strength, 1), 0)
}

// ---- 透视强度换算 ----
const kMax = tiltStrengthFromDegrees(MAX_TILT_DEGREES)
checkClose('80° 的强度等于 tan80°', kMax, Math.tan((80 * Math.PI) / 180))
check('超过上限会被夹住', tiltStrengthFromDegrees(120) === kMax, true)
check('负数当作关闭', tiltStrengthFromDegrees(-20), 0)
check('NaN 角度当作关闭', tiltStrengthFromDegrees(Number.NaN), 0)
// tan 在接近 90° 时会炸，所以上限必须离 90° 有余量，否则透视系数会变成几十上百
check('上限处的强度仍是可控的个位数', kMax > 1 && kMax < 10, true)

// ---- 越远越小、越远越靠上 ----
check('最远处会缩小', depthScale(kMax, 1) < 1, true)
checkClose('80° 时最远处缩到 15%', depthScale(kMax, 1), 1 / (1 + kMax))
check('深度越大缩得越小（单调）', depthScale(kMax, 1.5) < depthScale(kMax, 0.5), true)

// screenRatio 对深度必须严格递减，否则提前退出（break）的单调性不成立，
// 音符会出现"倒退"的诡异现象
let monotonic = true
let previous = Number.POSITIVE_INFINITY
for (let d = -0.2; d <= 1.5; d += 0.01) {
  const value = screenRatio(kMax, d)
  if (value > previous + 1e-12) monotonic = false
  previous = value
}
check('竖直位置对深度严格递减（不会倒退）', monotonic, true)

// ---- 加速感的来源：近处屏幕速度必须大于远处 ----
// 音符沿轨道是匀速的，屏幕上却是"远处慢、近处快"，这就是透视自带的加速感。
const nearSpeed = Math.abs(screenRatio(kMax, 0.1) - screenRatio(kMax, 0))
const farSpeed = Math.abs(screenRatio(kMax, 1) - screenRatio(kMax, 0.9))
check('近处屏幕速度大于远处（= 加速感）', nearSpeed > farSpeed, true)
check('而且差距是数量级级别的', nearSpeed > farSpeed * 2, true)

// ---- scaleAtScreenY：画轨道梯形用的反函数 ----
checkClose('判定线处的缩放是 1', scaleAtScreenY(kMax, 600, 600), 1)
checkClose('画面顶端的缩放等于最远处缩放', scaleAtScreenY(kMax, 600, 0), 1 / (1 + kMax))
check('画面底部比判定线更宽（更靠近观察者）', scaleAtScreenY(kMax, 600, 720) > 1, true)
// 判定线以下最多变宽这么多，轨道必须还能留在画布里
const bottomWidening = scaleAtScreenY(kMax, 600, 720)
check('底部变宽控制在 20% 以内', bottomWidening < 1.2, true)
checkClose('0° 时任何高度都不缩放', scaleAtScreenY(0, 600, 720), 1)

// ---- 退化输入不能算出 NaN，否则整条轨道会消失 ----
check('NaN 深度不产生 NaN（会被剔除掉）', Number.isFinite(screenRatio(kMax, Number.NaN)), true)
check('NaN 深度不产生 NaN（缩放）', Number.isFinite(depthScale(kMax, Number.NaN)), true)
check('NaN 的 y 不产生 NaN', Number.isFinite(scaleAtScreenY(kMax, 600, Number.NaN)), true)
// 越过判定线极远处是投影奇点，必须返回有限值而不是 Infinity/NaN
check(
  '奇点附近仍返回有限值',
  Number.isFinite(screenRatio(kMax, -1 / kMax + 1e-9)) ||
    screenRatio(kMax, -1 / kMax + 1e-9) === Number.MAX_SAFE_INTEGER,
  true,
)
// 判定线高度为 0 也不能炸
check('判定线高度为 0 时仍有限', Number.isFinite(scaleAtScreenY(kMax, 0, 100)), true)

// ---- 投影极点（长条音符「按住一会儿整个消失」的回归测试） ----
//
// (1-u)/(1+ku) 在 u = -1/k 处分母过零，坐标会炸到 1e18 这种量级。
// 只要一条路径里有一个这样的顶点，Canvas 就会把**整条路径**都画不出来 ——
// 表现出来就是长条音符在按住一段时间之后整个消失。
//
// 触发条件是「头部过线之后又走了足够远」，所以只有够长的长条会中招
// （短长条在极点到来之前就整条过线、被剔除掉了）。

let poleViolations = 0
let maxAbsRatio = 0
let maxScale = 0
for (const degrees of [0, 1, 2, 5, 10, 20, 40, 60, 80]) {
  const k = tiltStrengthFromDegrees(degrees)
  // 从「过线很远」扫到「还在很远的未来」
  for (let depth = -30; depth <= 5; depth += 0.01) {
    const ratio = screenRatio(k, depth)
    const scale = depthScale(k, depth)
    if (!Number.isFinite(ratio) || !Number.isFinite(scale)) poleViolations++
    if (!(scale > 0) || scale > 2.0001) poleViolations++
    if (Math.abs(ratio) > maxAbsRatio) maxAbsRatio = Math.abs(ratio)
    if (scale > maxScale) maxScale = scale
  }
}
check('任何倾斜角 × 任何深度下投影都不会算出非有限值', poleViolations, 0)
check('纵向坐标有上界（不会再出现 1e18）', maxAbsRatio < 200, true)
check('横向缩放被夹在 2 倍以内', maxScale <= 2.0001, true)

// 夹取不能引入新问题，这两条前提必须同时成立：
//   ① 已经过线很远的音符仍要落在画面之外，否则判定线下方会堆一片残影
//   ② 判定线处（depth = 0）完全不受夹取影响，否则音符就不压在判定线上了
const probeJudgeLineY = 720 * 0.88
let cullFailures = 0
let centerFailures = 0
for (const degrees of [0, 5, 20, 40, 80]) {
  const k = tiltStrengthFromDegrees(degrees)
  if (screenRatio(k, -30) * probeJudgeLineY <= 720 + 80) cullFailures++
  if (Math.abs(screenRatio(k, 0) - 1) > 1e-12) centerFailures++
  if (Math.abs(depthScale(k, 0) - 1) > 1e-12) centerFailures++
}
check('过线很远的音符仍会被正确剔除', cullFailures, 0)
check('判定线处完全不受夹取影响', centerFailures, 0)

// 夹取应当只在判定线以下（depth < 0）生效，可见区域一点都不能被动到
// —— depth 在 0..5 之间时，夹取函数必须原样返回
let visibleRegionTouched = 0
for (const degrees of [1, 5, 20, 40, 80]) {
  const k = tiltStrengthFromDegrees(degrees)
  for (let depth = 0; depth <= 5; depth += 0.01) {
    const raw = (1 - depth) / (1 + k * depth)
    if (Math.abs(screenRatio(k, depth) - raw) > 1e-12) visibleRegionTouched++
  }
}
check('可见区域（depth >= 0）没有被夹取影响', visibleRegionTouched, 0)

// ---- 音符大小档位 ----
// 这个设置的价值全在"基准档必须和改造前一模一样"：
// 第 3 档换算出来的尺寸必须精确等于原来的硬编码公式。

console.log('\n[11] 音符大小档位')

check('档位范围是 1–5', MIN_NOTE_SIZE_LEVEL === 1 && MAX_NOTE_SIZE_LEVEL === 5, true)
check('默认档位是 3', DEFAULT_NOTE_SIZE_LEVEL, 3)
check('基准档的宽度比例是 0.84（= 原来左右各 8% 内边距）', noteSizePreset(3).widthRatio, 0.84)
check('基准档的厚度倍率是 1（= 原来的厚度）', noteSizePreset(3).thicknessScale, 1)

// 用真实的轨宽验证"第 3 档 == 改造前的公式"。
// 改造前：pad = max(3, laneWidth * 0.08)，宽 = laneWidth - pad*2
//        厚 = max(10, min(20, laneWidth*0.17))
let sizeRegressions = 0
for (const laneWidth of [60, 90, 120, 156, 200]) {
  const preset = noteSizePreset(3)
  const inset = Math.max(1, (laneWidth * (1 - preset.widthRatio)) / 2)
  const newWidth = laneWidth - inset * 2
  const newHeight = Math.max(10, Math.min(20, laneWidth * 0.17)) * preset.thicknessScale

  const oldPad = Math.max(3, laneWidth * 0.08)
  const oldWidth = laneWidth - oldPad * 2
  const oldHeight = Math.max(10, Math.min(20, laneWidth * 0.17))

  // 轨宽足够时应当完全一致；极窄轨道下旧的最小内边距是 3px，会有细微差别
  if (laneWidth >= 90 && Math.abs(newWidth - oldWidth) > 1e-9) sizeRegressions++
  if (Math.abs(newHeight - oldHeight) > 1e-9) sizeRegressions++
}
check('第 3 档与改造前的尺寸完全一致（轨宽 >= 90px）', sizeRegressions, 0)

// 档位越高必须越大，两个维度都要单调
let notMonotonic = 0
for (let level = 1; level < 5; level++) {
  const lo = noteSizePreset(level)
  const hi = noteSizePreset(level + 1)
  if (!(hi.widthRatio > lo.widthRatio)) notMonotonic++
  if (!(hi.thicknessScale > lo.thicknessScale)) notMonotonic++
}
check('1→5 档宽度和厚度都严格单调递增', notMonotonic, 0)

// 宽度绝不能超过 1.0 —— 音符溢到隔壁轨道上看着就坏了
let widthOverflow = 0
for (let level = -5; level <= 10; level++) {
  if (noteSizePreset(level).widthRatio > 1) widthOverflow++
}
check('任何档位的宽度都不会超过轨道', widthOverflow, 0)

// 非法输入必须回到基准档，而不是夹到边界
check('超出范围向下夹到 1 档', noteSizePreset(0).widthRatio, noteSizePreset(1).widthRatio)
check('超出范围向上夹到 5 档', noteSizePreset(99).widthRatio, noteSizePreset(5).widthRatio)
check('NaN 回到基准档', noteSizePreset(Number.NaN).widthRatio, 0.84)
check('小数档位四舍五入', noteSizePreset(3.6).widthRatio, noteSizePreset(4).widthRatio)

// ---- 轨道区域宽度 ----
// 这是"游玩区多大"的主旋钮。硬上限关系到"倾斜时会不会画出界"，
// 所以下面这几条里最重要的是"任何尺寸下都不超过画布的 86%"。

const PLAYFIELD_HARD_CAP = 0.86

for (const canvasWidth of [320, 400, 600, 868, 1048, 1208, 1600, 2560]) {
  for (const keyCount of [4, 5, 6, 7]) {
    const width = computePlayfieldWidth(canvasWidth, keyCount)
    if (width > canvasWidth * PLAYFIELD_HARD_CAP + 1e-9) {
      check(`画布 ${canvasWidth} / ${keyCount}K 时不溢出`, width, `<= ${canvasWidth * PLAYFIELD_HARD_CAP}`)
    }
  }
}
check('各种画布宽度和键数下轨道都不溢出画布', true, true)

checkClose('1200 宽 4K 用满上限轨宽（200px）', computePlayfieldWidth(1200, 4), 800)
checkClose('868 宽 4K 时轨宽 156px', computePlayfieldWidth(868, 4) / 4, (868 * 0.72) / 4)
check('比旧版（120px 轨宽）明显更宽', computePlayfieldWidth(868, 4) / 4 > 120, true)
check('窄画布下不会因为轨宽下限而溢出', computePlayfieldWidth(400, 4) <= 400 * PLAYFIELD_HARD_CAP + 1e-9, true)
check('7K 也能被硬上限兜住', computePlayfieldWidth(800, 7) <= 800 * PLAYFIELD_HARD_CAP + 1e-9, true)
check('轨宽不会无限增长（有上限）', computePlayfieldWidth(5000, 4) <= 4 * MAX_LANE_WIDTH + 1e-9, true)

// 退化输入
check('画布宽度为 0 时不产生 NaN', Number.isFinite(computePlayfieldWidth(0, 4)), true)
check('键数为 0 时不产生 NaN', Number.isFinite(computePlayfieldWidth(800, 0)), true)
check('画布宽度为负时不产生负数', computePlayfieldWidth(-100, 4) >= 0, true)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n通过 ${passes} 项，失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)

// ---------------------------------------------------------------------------
// 最小 ZIP 写入器（仅测试用）
// ---------------------------------------------------------------------------

/**
 * 造一个只含 deflate 条目的 zip。
 *
 * 结构就是标准的 [本地头][数据]... [中央目录] [EOCD]，
 * 和 src/osu/unzip.ts 里注释描述的一致 —— 两边独立实现，正好互相验证。
 */
function buildZip(entries) {
  const parts = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data)
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)

    // ---- 本地文件头（30 字节固定部分）----
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 签名
    local.writeUInt16LE(20, 4) // 解压所需版本
    local.writeUInt16LE(0, 6) // 通用位标记
    local.writeUInt16LE(8, 8) // 压缩方式 8 = deflate
    local.writeUInt16LE(0, 10) // 修改时间
    local.writeUInt16LE(0x21, 12) // 修改日期（随便一个合法值）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度

    parts.push(local, nameBytes, compressed)

    // ---- 中央目录条目（46 字节固定部分）----
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0) // 签名
    cen.writeUInt16LE(20, 4) // 由什么版本创建
    cen.writeUInt16LE(20, 6) // 解压所需版本
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(8, 10) // 压缩方式
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(compressed.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBytes.length, 28)
    cen.writeUInt16LE(0, 30) // 扩展字段长度
    cen.writeUInt16LE(0, 32) // 注释长度
    cen.writeUInt16LE(0, 34) // 起始磁盘号
    cen.writeUInt16LE(0, 36) // 内部属性
    cen.writeUInt32LE(0, 38) // 外部属性
    cen.writeUInt32LE(offset, 42) // 本地头在文件里的偏移

    central.push(cen, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }

  const centralBuffer = Buffer.concat(central)

  // ---- EOCD（22 字节）----
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // 签名
  eocd.writeUInt16LE(0, 4) // 当前磁盘号
  eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8) // 本磁盘上的条目数
  eocd.writeUInt16LE(entries.length, 10) // 总条目数
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16) // 中央目录起始偏移
  eocd.writeUInt16LE(0, 20) // 注释长度

  const out = Buffer.concat([...parts, centralBuffer, eocd])
  // Buffer.concat 在小于 4KB 时可能复用内部内存池，所以必须切出属于自己的一段
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
}

/**
 * CRC32 校验。ZIP 的每个条目都必须带校验值。
 *
 * 查表**刻意建在函数内部**，而不是做成模块级的常量/缓存变量。
 * 因为本文件顶部就会调用 buildZip()，而模块后半部分声明的 let/const
 * 此时还处在「暂时性死区」（TDZ）—— 函数声明会整体提升所以能调用，
 * 但它内部一旦碰到后面那些 let/const 就会直接抛 ReferenceError。
 * 256 项的表在测试里总共只建两三次，开销可以忽略。
 */
function crc32(data) {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }

  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
