/**
 * extract-osu.mjs —— 把 `.osz` / `.zip` 里的 `.osu` 文件抽出来。
 *
 * 用途：把真实谱面包变成可以单独喂给解析器的 `.osu` 文件，
 * 方便对拍（tools/c-backend-crosscheck.mjs）和端到端测试（tools/c-backend-e2e.mjs）。
 *
 * 用法：
 *   node tools/extract-osu.mjs <file.osz> <输出目录>
 *
 * 会按压缩包内的原始文件名写盘（只取 basename，避免目录穿越）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { readZip } from '../src/osu/unzip.ts'

const [, , input, outputDir] = process.argv

if (input === undefined || outputDir === undefined) {
  console.error('用法: node tools/extract-osu.mjs <file.osz> <输出目录>')
  process.exit(2)
}

const raw = readFileSync(input)
const files = await readZip(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))

const target = resolve(outputDir)
mkdirSync(target, { recursive: true })

let count = 0
for (const [name, bytes] of files) {
  if (!/\.osu$/i.test(name)) {
    continue
  }
  // 只取文件名部分：压缩包内可能有 子目录/xxx.osu，直接拼会用上目录
  const safeName = basename(name).replace(/[<>:"/\\|?*]/g, '_')
  const outPath = join(target, safeName)
  writeFileSync(outPath, bytes)
  count++
  console.log(`  ${bytes.length.toString().padStart(8)} B  ${safeName}`)
}

console.log(`\n共抽出 ${count} 个 .osu → ${target}`)
