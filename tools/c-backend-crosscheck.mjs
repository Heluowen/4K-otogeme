/**
 * c-backend-crosscheck.mjs —— C 后端与 TypeScript 解析器的对拍测试。
 *
 * 思路：同一份 `.osu` 文本，分别喂给
 *   - TypeScript 的 `parseOsu()`     （src/osu/parser.ts）
 *   - C 后端的 `--parse` 模式         （c-backend/src/osu_parser.c）
 * 两边输出规范化 JSON，然后**逐字节比较**。
 *
 * 为什么这是最强的验证方式：两个独立实现如果对真实谱面的每一个字段都一致，
 * 就几乎不可能在同一个地方犯同样的错。相比之下，"读一遍代码觉得没问题"
 * 完全不值钱。
 *
 * 用法：
 *   node tools/c-backend-crosscheck.mjs <exe> <file.osu | file.osz> ...
 *
 *   .osz / .zip 会自动解出里面所有 .osu 分别比较。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

import { parseOsu } from '../src/osu/parser.ts'
import { readZip } from '../src/osu/unzip.ts'

/** 把 parseOsu 的结果规范化成与 C 端一致的形状。 */
function normalizeTs(text) {
  const b = parseOsu(text)
  return JSON.stringify({
    ok: true,
    formatVersion: b.formatVersion,
    audioFilename: b.audioFilename,
    backgroundFilename: b.backgroundFilename,
    mode: b.mode,
    title: b.title,
    artist: b.artist,
    creator: b.creator,
    version: b.version,
    circleSize: b.circleSize,
    overallDifficulty: b.overallDifficulty,
    timingPoints: b.timingPoints.map((t) => ({
      time: t.time,
      beatLength: t.beatLength,
      uninherited: t.uninherited,
    })),
    hitObjects: b.hitObjects.map((h) => ({
      x: h.x,
      time: h.time,
      endTime: h.endTime,
      isHold: h.isHold,
    })),
  })
}

/** 调用 C 可执行文件解析一段文本，返回它输出的 JSON 字符串。 */
function normalizeC(exe, workDir, text, tag) {
  const inPath = join(workDir, `${tag}.osu`)
  const outPath = join(workDir, `${tag}.json`)
  // 用 UTF-8 写入 —— .osu 里的曲名/谱师名几乎总是 UTF-8
  writeFileSync(inPath, text, { encoding: 'utf8' })
  execFileSync(exe, ['--parse', inPath, outPath], { stdio: 'pipe' })
  return readFileSync(outPath, 'utf8')
}

/**
 * 找出第一处差异并给出上下文。
 * 只说"不相等"是没有信息量的，必须能定位到具体字段。
 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const from = Math.max(0, i - 60)
  return {
    at: i,
    left: a.slice(from, i + 60),
    right: b.slice(from, i + 60),
  }
}

async function main() {
  const [exe, ...inputs] = process.argv.slice(2)
  if (exe === undefined || inputs.length === 0) {
    console.error('用法: node tools/c-backend-crosscheck.mjs <exe> <file.osu|file.osz> ...')
    process.exit(2)
  }

  const workDir = mkdtempSync(join(tmpdir(), 'r4k-crosscheck-'))
  let pass = 0
  let fail = 0
  const failures = []

  try {
    for (const input of inputs) {
      const raw = readFileSync(input)
      const isZip = /\.(osz|zip)$/i.test(input)

      /** @type {{ name: string, text: string }[]} */
      let cases = []

      if (isZip) {
        // 复用项目自己的零依赖 zip 读取器，按 ArrayBuffer 传进去
        const files = await readZip(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
        for (const [name, bytes] of files) {
          if (!/\.osu$/i.test(name)) continue
          cases.push({ name, text: new TextDecoder('utf-8').decode(bytes) })
        }
        console.log(`\n${basename(input)}  →  解出 ${cases.length} 个 .osu`)
      } else {
        cases = [{ name: basename(input), text: raw.toString('utf8') }]
        console.log(`\n${basename(input)}`)
      }

      for (const [index, item] of cases.entries()) {
        const tag = `case${index}`
        let tsOut
        let cOut

        try {
          tsOut = normalizeTs(item.text)
        } catch (error) {
          console.log(`  ✗ ${item.name}\n      TS 解析抛异常: ${error.message}`)
          fail++
          failures.push({ input, name: item.name, reason: `TS threw: ${error.message}` })
          continue
        }

        try {
          cOut = normalizeC(exe, workDir, item.text, tag)
        } catch (error) {
          console.log(`  ✗ ${item.name}\n      C 解析器执行失败: ${error.message}`)
          fail++
          failures.push({ input, name: item.name, reason: `C failed: ${error.message}` })
          continue
        }

        const noteCount = JSON.parse(tsOut).hitObjects.length

        if (tsOut === cOut) {
          pass++
          console.log(`  ✓ ${item.name}  (${noteCount} 个音符, ${tsOut.length} 字符，逐字节一致)`)
        } else {
          fail++
          const diff = firstDiff(tsOut, cOut)
          console.log(`  ✗ ${item.name}  (${noteCount} 个音符)`)
          console.log(`      首个差异 @${diff.at}`)
          console.log(`      TS: ...${diff.left}...`)
          console.log(`       C: ...${diff.right}...`)
          failures.push({ input, name: item.name, reason: `diff at ${diff.at}` })
        }
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`对拍结果：通过 ${pass}，失败 ${fail}`)

  if (fail > 0) {
    console.log('\n失败清单:')
    for (const f of failures) {
      console.log(`  - ${basename(f.input)} / ${f.name}: ${f.reason}`)
    }
  }

  process.exit(fail === 0 ? 0 : 1)
}

// 顶层 await 需要模块作用域；main 是 async 但这里不 await 也能跑（脚本末尾无后续逻辑），
// 显式 await 更清晰，也保证退出码在 finally 之后才确定。
await main()
