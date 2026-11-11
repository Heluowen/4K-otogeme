/**
 * c-backend-e2e.mjs —— 端到端验证 C 后端接入的两条路径。
 *
 * ============================ 这个脚本验证什么 ============================
 *
 * `src/osu/backend.ts` 的 `parseOsuSmart()` 有两条路：
 *   A. 探测到 C 后端 → `.osu` 文本 POST 到 `/api/parse`
 *   B. 探测不到（或请求失败） → 静默回落到内置 TypeScript 解析器
 *
 * 只读代码是看不出 B 到底会不会真的触发。所以这里把**真实的 backend.ts**
 * 直接 import 进来，分别在有/无后端两种情况下各跑一次，然后断言：
 *   1. 有后端时确实走了 C 后端（engine === 'c-backend'）
 *   2. 没后端时确实回落了（engine === 'builtin'），且**没有抛异常**
 *   3. 两条路解析出来的谱面**完全一致**
 *
 * ============================ 为什么能直接 import ============================
 *
 * backend.ts 内部的导入显式写了 `.ts` 扩展名（tsconfig 里开了
 * allowImportingTsExtensions），所以 Node 的 ESM 加载器能直接解析它，
 * 不需要打包器。Node 24 原生支持类型擦除，`.ts` 可以直接运行。
 *
 * 用法：
 *   node tools/c-backend-e2e.mjs <file.osu> <backend-url>
 *   node tools/c-backend-e2e.mjs <file.osu> --offline
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const BACKEND_ENTRY = join(PROJECT_ROOT, 'src', 'osu', 'backend.ts')

/* ===========================================================================
 * 子进程模式
 *
 * 必须换进程重测：探测结果（probeState）是模块级状态，同一个进程里
 * 第二次探测会直接拿到缓存值，测不出"回落"这条路径。
 * ========================================================================= */
async function runChild() {
  const [, , , osuPath, mode, backendUrl] = process.argv

  if (mode === 'online' && backendUrl !== undefined) {
    // 运行时注入后端地址（backend.ts 支持 window.__R4K_BACKEND__ 这种全局覆盖）
    globalThis.__R4K_BACKEND__ = backendUrl
  }

  // 动态 import：必须在设置全局变量之后才加载模块
  const mod = await import(pathToFileURL(BACKEND_ENTRY).href)

  const text = readFileSync(osuPath, 'utf8')

  let beatmap
  let threw = null
  try {
    beatmap = await mod.parseOsuSmart(text)
  } catch (error) {
    threw = String(error && error.message ? error.message : error)
  }

  const payload = {
    engine: mod.getActiveEngine(),
    label: mod.getBackendLabel(),
    settled: mod.isProbeSettled(),
    threw,
    beatmap:
      beatmap === undefined
        ? null
        : {
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
            timingPoints: beatmap.timingPoints,
            hitObjects: beatmap.hitObjects,
          },
  }

  process.stdout.write(JSON.stringify(payload))
}

/* ===========================================================================
 * 主流程
 * ========================================================================= */
async function main() {
  const [osuPath, target] = process.argv.slice(2)

  if (osuPath === undefined || target === undefined) {
    console.error('用法: node tools/c-backend-e2e.mjs <file.osu> <backend-url | --offline>')
    process.exit(2)
  }

  const osuAbs = resolve(osuPath)
  if (!existsSync(osuAbs)) {
    console.error(`找不到文件: ${osuAbs}`)
    process.exit(2)
  }

  const selfPath = fileURLToPath(import.meta.url)

  /** 在独立进程里跑一次。 */
  function runInChild(mode, url) {
    const args = [selfPath, '--child', osuAbs, mode]
    if (url !== undefined) {
      args.push(url)
    }
    const out = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' })
    return JSON.parse(out)
  }

  const offline = runInChild('offline')
  const online = target === '--offline' ? undefined : runInChild('online', target)

  let failures = 0
  const report = (ok, message) => {
    if (ok) {
      console.log(`  ok    ${message}`)
    } else {
      failures++
      console.log(`  FAIL  ${message}`)
    }
  }

  console.log(`\n后端接入端到端验证（样本: ${osuPath}）\n`)

  if (online !== undefined) {
    report(online.threw === null, '有后端时不抛异常')
    report(online.engine === 'c-backend', `有后端时走 C 后端（实际: ${online.engine}）`)
    report(online.label !== '', `拿到后端标识（${online.label || '空'}）`)
  }

  report(offline.threw === null, '无后端时不抛异常')
  report(offline.engine === 'builtin', `无后端时回落到内置解析器（实际: ${offline.engine}）`)
  report(offline.settled === true, '探测状态已确定（不会永远停在 unknown）')
  report(
    offline.beatmap !== null && offline.beatmap.hitObjects.length > 0,
    `回落路径解析出音符（${offline.beatmap === null ? 0 : offline.beatmap.hitObjects.length} 个）`,
  )

  if (online !== undefined && online.beatmap !== null && offline.beatmap !== null) {
    const same = JSON.stringify(online.beatmap) === JSON.stringify(offline.beatmap)
    report(same, '两条路径解析出的谱面完全一致')
    if (!same) {
      console.log(
        `        C 路径音符 ${online.beatmap.hitObjects.length} / 内置 ${offline.beatmap.hitObjects.length}`,
      )
    }
  }

  console.log(failures === 0 ? '\n端到端验证通过\n' : `\n端到端验证失败 ${failures} 项\n`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv[2] === '--child') {
  await runChild()
} else {
  await main()
}
