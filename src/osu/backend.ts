/*
 * 注意这两个导入**显式带了 .ts 扩展名**。
 *
 * 项目其余地方都是省略扩展名的，那是因为 Vite 能解析。但这里的模块需要在
 * Node 里被直接 import 做端到端测试（tools/c-backend-e2e.mjs）——
 * Node 的 ESM 加载器不会自动补扩展名，省略就解析失败。
 * 显式写出来之后，Vite 和 Node 两边都能加载。
 */
import type { OsuBeatmap, OsuHitObject, OsuTimingPoint } from './parser.ts'
import { parseOsu } from './parser.ts'

/**
 * C 后端的客户端。
 *
 * ============================ 为什么要有这一层 ============================
 *
 * 项目本来有两条可用的运行路径：纯静态（含单文件 HTML）和自带服务器。
 * 接入 C 后端之后变成三条，而**任何一条都不能因为后端不在而失效** ——
 * 单文件 HTML 双击打开时必须照常能玩。
 *
 * 所以这里的策略是「**探测 + 回落**」：
 *   1. 启动时探测一次 `GET /api/health`；
 *   2. 探测成功 → `.osu` 文本发给 C 解析；
 *   3. 探测失败、请求超时、返回格式不对 → **静默回落到内置 TypeScript 解析器**。
 *
 * 用户永远感觉不到失败，只是"用了哪个解析器"不同而已（界面上会显示出来）。
 *
 * ============================ 为什么不需要自己解压 ============================
 *
 * 解压留在浏览器（`DecompressionStream`），C 端只接收**纯文本**的 `.osu`。
 * 这样 C 侧不必实现 DEFLATE —— 那是几百行、且与"解析格式"完全无关的代码。
 * 边界划在「字节 → 文本」之后、「文本 → 结构」之前。
 */

/** 后端地址的解析结果缓存（解析一次就够，拼接在每次请求上）。 */
let cachedBaseUrl: string | null = null

/** 探测状态。一旦判定不可用就不再重试，避免每张谱面都等一次超时。 */
let probeState: 'unknown' | 'available' | 'unavailable' = 'unknown'
let probePromise: Promise<boolean> | null = null

/** 最近一次实际使用的解析器，供界面显示。 */
let activeEngine: ParseEngine = 'builtin'

/** 后端自报的服务名，例如 "rhythm-4k-c-backend 0.1.0"。 */
let backendLabel = ''

export type ParseEngine = 'c-backend' | 'builtin'

/** 探测超时。给得短一点：后端不在时不该让用户干等。 */
const PROBE_TIMEOUT_MS = 1_000

/** 解析超时。大谱面（5000+ 音符）在本地回环上是毫秒级，30 秒是兜底。 */
const PARSE_TIMEOUT_MS = 30_000

/**
 * 读构建期注入的后端地址。
 *
 * `import.meta.env` 由 Vite 在构建期替换成字面量对象。这里刻意**先取出整个对象
 * 再取属性**，并加可选链：万一这段代码在没有 Vite 注入的环境里被执行
 * （比如在 Node 里直接 import 本模块跑单测），`import.meta.env` 会是 undefined，
 * 直接写 `import.meta.env.VITE_BACKEND_URL` 会抛 TypeError。
 */
function readEnvBackendUrl(): string {
  const env = import.meta.env as Record<string, unknown> | undefined
  const value = env?.VITE_BACKEND_URL
  return typeof value === 'string' ? value : ''
}

/**
 * 后端地址。
 *
 * 优先级：
 *   1. 运行时注入 `window.__R4K_BACKEND__`（方便临时指向别的端口，不用重新构建）
 *   2. 构建期 `VITE_BACKEND_URL`（`npm run build` 时定死）
 *   3. 空串 = 同源（用 C 服务器托管前端时就是这个情况）
 */
function resolveBaseUrl(): string {
  if (cachedBaseUrl !== null) {
    return cachedBaseUrl
  }

  const injected = (globalThis as { __R4K_BACKEND__?: unknown }).__R4K_BACKEND__
  if (typeof injected === 'string' && injected !== '') {
    cachedBaseUrl = injected.replace(/\/+$/, '')
    return cachedBaseUrl
  }

  const fromEnv = readEnvBackendUrl()
  if (fromEnv !== '') {
    cachedBaseUrl = fromEnv.replace(/\/+$/, '')
    return cachedBaseUrl
  }

  cachedBaseUrl = ''
  return cachedBaseUrl
}

/** 带超时的 fetch。`AbortController` 是唯一能在 fetch 上设超时的标准做法。 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测后端是否可用。结果会被缓存，多次调用只会真正请求一次。
 *
 * 典型用法是在应用启动时就调一次 —— 让探测和用户"拖文件进来"的动作并行，
 * 而不是等导入时才额外等一次网络往返。
 */
export async function ensureProbe(): Promise<boolean> {
  if (probeState === 'available') {
    return true
  }
  if (probeState === 'unavailable') {
    return false
  }
  if (probePromise !== null) {
    return probePromise
  }

  probePromise = (async (): Promise<boolean> => {
    try {
      const response = await fetchWithTimeout(
        `${resolveBaseUrl()}/api/health`,
        { method: 'GET', headers: { Accept: 'application/json' } },
        PROBE_TIMEOUT_MS,
      )
      if (!response.ok) {
        probeState = 'unavailable'
        return false
      }
      const data: unknown = await response.json()
      if (isRecord(data) && data.ok === true) {
        probeState = 'available'
        activeEngine = 'c-backend'
        const service = typeof data.service === 'string' ? data.service : 'c-backend'
        const version = typeof data.version === 'string' ? ` v${data.version}` : ''
        backendLabel = `${service}${version}`
        return true
      }
      probeState = 'unavailable'
      return false
    } catch {
      // 网络错误、超时、`file://` 下 fetch 直接抛、跨源被拦……全走这里。
      probeState = 'unavailable'
      return false
    } finally {
      probePromise = null
    }
  })()

  return probePromise
}

/** 当前实际使用的解析器。 */
export function getActiveEngine(): ParseEngine {
  return activeEngine
}

/** 后端自报的名字；不可用时返回空串。 */
export function getBackendLabel(): string {
  return backendLabel
}

/** 探测结果是否已经确定（界面用来避免"未知"状态闪烁）。 */
export function isProbeSettled(): boolean {
  return probeState !== 'unknown'
}

/* ===========================================================================
 * 响应校验
 *
 * C 端返回的是 JSON，而 JSON.parse 的结果类型是 unknown。**永远不要直接
 * cast 成 OsuBeatmap** —— 后端一旦改了字段名或者返回了错误结构，后续代码
 * 会以"某个字段是 undefined"的形式炸在很远的地方，极难排查。
 * 这里逐字段检查，不合格就返回 null，由调用方回落到内置解析器。
 * ========================================================================= */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 把后端 JSON 转成 OsuBeatmap。结构不对返回 null。 */
function toOsuBeatmap(raw: unknown): OsuBeatmap | null {
  if (!isRecord(raw) || raw.ok !== true) {
    return null
  }

  const timingPoints: OsuTimingPoint[] = []
  if (Array.isArray(raw.timingPoints)) {
    for (const item of raw.timingPoints) {
      if (!isRecord(item)) {
        continue
      }
      timingPoints.push({
        time: asFiniteNumber(item.time, 0),
        beatLength: asFiniteNumber(item.beatLength, 0),
        uninherited: item.uninherited === true,
      })
    }
  }

  const hitObjects: OsuHitObject[] = []
  if (Array.isArray(raw.hitObjects)) {
    for (const item of raw.hitObjects) {
      if (!isRecord(item)) {
        continue
      }
      hitObjects.push({
        x: asFiniteNumber(item.x, 0),
        time: asFiniteNumber(item.time, 0),
        endTime: asFiniteNumber(item.endTime, 0),
        isHold: item.isHold === true,
      })
    }
  }

  return {
    formatVersion: asFiniteNumber(raw.formatVersion, 0),
    audioFilename: asString(raw.audioFilename),
    backgroundFilename: asString(raw.backgroundFilename),
    mode: asFiniteNumber(raw.mode, 0),
    title: asString(raw.title),
    artist: asString(raw.artist),
    creator: asString(raw.creator),
    version: asString(raw.version),
    circleSize: asFiniteNumber(raw.circleSize, 4),
    overallDifficulty: asFiniteNumber(raw.overallDifficulty, 5),
    timingPoints,
    hitObjects,
  }
}

/**
 * 解析一段 `.osu` 文本：优先走 C 后端，不可用或出错时回落到内置解析器。
 *
 * ⚠️ 这个函数**不会抛异常**（除了内置解析器自己抛的）。网络问题一律降级，
 *    不能让"后端挂了"变成"谱面打不开"。
 */
export async function parseOsuSmart(text: string): Promise<OsuBeatmap> {
  const available = await ensureProbe()

  if (available) {
    try {
      const response = await fetchWithTimeout(
        `${resolveBaseUrl()}/api/parse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: text,
        },
        PARSE_TIMEOUT_MS,
      )

      // 注意：解析失败时后端返回 400 + {"ok":false,...}，这里统一当作"降级"处理。
      const data: unknown = await response.json().catch(() => null)
      const beatmap = toOsuBeatmap(data)

      if (beatmap !== null) {
        activeEngine = 'c-backend'
        return beatmap
      }

      // 后端给出了可读的错误原因，记一条警告方便排查
      if (isRecord(data) && typeof data.error === 'string') {
        console.warn(`[backend] 解析失败，回落到内置解析器：${data.error}`)
      }
    } catch (error) {
      console.warn('[backend] 请求失败，回落到内置解析器', error)
    }
  }

  activeEngine = 'builtin'
  return parseOsu(text)
}
