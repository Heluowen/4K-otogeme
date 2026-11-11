/**
 * c-backend-check.mjs —— 一条命令跑完 C 后端的全部验证。
 *
 * 依次执行：
 *   1. C 单元测试（c-backend/build/test-osu.exe）
 *   2. 对拍：C 解析器 vs TypeScript 解析器（fixture + save/ 下的真实谱面包）
 *   3. 端到端：起一个真实服务器，验证 backend.ts 的有/无后端两条路径
 *
 * 用法：npm run ccheck
 *
 * 前提：已经构建过 C 后端（npm run cbuild，或 c-backend/build.bat）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const EXE = join(ROOT, 'c-backend', 'build', 'rhythm4k-server.exe')
const TEST_EXE = join(ROOT, 'c-backend', 'build', 'test-osu.exe')

const PORT = 8199
const BASE = `http://127.0.0.1:${PORT}`

/** 跑一个前台命令，把输出原样透传。返回是否成功。 */
function run(label, command, args, options = {}) {
  console.log(`\n${'='.repeat(64)}`)
  console.log(`  ${label}`)
  console.log('='.repeat(64))
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    ...options,
  })
  return result.status === 0
}

/** 等待服务器就绪：反复探活，最多等 timeoutMs。 */
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) {
        return true
      }
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/** 强制结束进程（Windows 上 child.kill() 对原生程序不一定生效）。 */
function forceKill(pid) {
  if (pid === undefined) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出
    }
  }
}

/** 收集 save/ 目录下的真实谱面包（可能不存在）。 */
function collectRealCharts() {
  const saveDir = join(ROOT, '..', 'save')
  if (!existsSync(saveDir)) {
    return []
  }
  try {
    return readdirSync(saveDir)
      .filter((name) => /\.(osz|zip)$/i.test(name))
      .map((name) => join(saveDir, name))
  } catch {
    return []
  }
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`找不到 ${EXE}`)
    console.error('请先构建：  npm run cbuild      （或运行 c-backend/build.bat）')
    process.exit(2)
  }

  const results = []

  /* ── 1. C 单元测试 ── */
  results.push(['C 单元测试', existsSync(TEST_EXE) && run('C 单元测试', TEST_EXE, [])])

  /* ── 2. 对拍 ── */
  const chartFiles = [join(ROOT, 'tools', 'fixture', 'chart.osu'), ...collectRealCharts()]
  results.push([
    `对拍（${chartFiles.length} 个样本）`,
    run('C ↔ TypeScript 对拍', process.execPath, [
      join(HERE, 'c-backend-crosscheck.mjs'),
      EXE,
      ...chartFiles,
    ]),
  ])

  /* ── 3. 端到端 ── */
  let server
  let e2eOk = false
  try {
    // stdio: 'ignore' 有两个好处：不占管道，也不会把服务器日志混进测试输出
    server = spawn(EXE, ['--root', join(ROOT, 'dist'), '--port', String(PORT), '--quiet'], {
      stdio: 'ignore',
      windowsHide: true,
    })

    const ready = await waitForServer(4000)
    if (!ready) {
      console.error('\n  FAIL  服务器在 4 秒内没有就绪')
      e2eOk = false
    } else {
      e2eOk = run('端到端（真实 HTTP）', process.execPath, [
        join(HERE, 'c-backend-e2e.mjs'),
        join(ROOT, 'tools', 'fixture', 'chart.osu'),
        BASE,
      ])
    }
  } finally {
    forceKill(server && server.pid)
  }
  results.push(['端到端（真实 HTTP）', e2eOk])

  /* ── 汇总 ── */
  console.log(`\n${'='.repeat(64)}`)
  console.log('  汇总')
  console.log('='.repeat(64))
  let failed = 0
  for (const [label, ok] of results) {
    console.log(`  ${ok ? '✓' : '✗'}  ${label}`)
    if (!ok) {
      failed++
    }
  }

  // 顺手清掉可能的临时目录
  rmSync(join(ROOT, '.tmp-e2e'), { recursive: true, force: true })

  console.log(failed === 0 ? '\n全部通过\n' : `\n${failed} 项失败\n`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
