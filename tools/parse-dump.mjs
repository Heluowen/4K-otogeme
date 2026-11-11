/**
 * parse-dump.mjs —— 把 TypeScript 版 `parseOsu()` 的结果打成规范化 JSON。
 *
 * 用途：和 C 后端的 `/api/parse`（或 CLI 的 `--parse` 模式）做**逐字节对拍**。
 *
 * 两个解析器如果对同一个文件输出完全相同的 JSON，就说明它们在所有字段上一致；
 * 这比人工核对几十个字段靠谱得多，也是「两套实现」唯一站得住的验证方式。
 *
 * 用法：
 *   node tools/parse-dump.mjs <file.osu>
 */
import { readFileSync } from 'node:fs'
import { parseOsu } from '../src/osu/parser.ts'

const path = process.argv[2]
if (path === undefined) {
  console.error('用法: node tools/parse-dump.mjs <file.osu>')
  process.exit(2)
}

const text = readFileSync(path, 'utf8')
const beatmap = parseOsu(text)

/**
 * 重新组装一遍，而不是直接 JSON.stringify(beatmap)。
 *
 * 原因：JSON.stringify 会保留对象里所有字段（包括将来可能新增的内部字段），
 * 而 C 端只输出约定的那几项。显式列出字段能让「两边输出相同」这件事有意义 ——
 * 它验证的是约定，不是实现细节的巧合。
 */
const normalized = {
  ok: true,
  formatVersion: beatmap.formatVersion,
  audioFilename: beatmap.audioFilename,
  backgroundFilename: beatmap.backgroundFilename,
  mode: beatmap.mode,
  title: beatmap.title,
  artist: beatmap.artist,
  creator: beatmap.creator,
  version: beatmap.version,
  circleSize: beatmap.circleSize,
  overallDifficulty: beatmap.overallDifficulty,
  timingPoints: beatmap.timingPoints.map((t) => ({
    time: t.time,
    beatLength: t.beatLength,
    uninherited: t.uninherited,
  })),
  hitObjects: beatmap.hitObjects.map((h) => ({
    x: h.x,
    time: h.time,
    endTime: h.endTime,
    isHold: h.isHold,
  })),
}

process.stdout.write(JSON.stringify(normalized))
