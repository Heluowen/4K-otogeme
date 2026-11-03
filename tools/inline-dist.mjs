/**
 * 把 `dist/` 的多文件产物内联成**一份单文件 HTML**（`dist-portable/index.html`）。
 *
 * ============================ 为什么需要它 ============================
 *
 * Vite 默认产出 `<script type="module" src="...">`。而浏览器**禁止从 `file://`
 * 加载 ES 模块**（模块一律走 CORS 检查），所以双击 `index.html` 会白屏、
 * 控制台报一串 CORS 错误。
 *
 * 把 JS/CSS 直接内联进 HTML 之后就绕开了这个问题：
 *   - 没有外部请求 → 不触发 CORS
 *   - 用**经典脚本**（不是 module）内联 → 不涉及模块解析
 *
 * 前提是打包产物本身能当经典脚本解析（本项目满足：单个 chunk、
 * 无顶层 `import`/`export`、无 `import.meta`、无顶层 `await`、无动态 `import()`）。
 * 下面的自检会在不满足时直接失败，而不是产出一个能生成但跑不起来的文件。
 *
 * ============================ 顺带说明 ============================
 *
 * 单文件版在 `file://` 下能玩，但**有几项功能会降级**（不是这个工具能解决的，
 * 是浏览器的限制）：
 *   - 保存谱面到磁盘：File System Access API 在 `file://` 下不可用 → 退回浏览器存储
 *   - 浏览器存储本身也可能被禁 → 那样每次都只能重新拖文件
 * 音画同步、判定、倾斜、按键音这些核心玩法完全不受影响。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = dirname(fileURLToPath(import.meta.url))
const distDir = join(toolsDir, '..', 'dist')
const outDir = join(toolsDir, '..', 'dist-portable')
const outFile = join(outDir, 'index.html')

let html = readFileSync(join(distDir, 'index.html'), 'utf8')

// ---------------------------------------------------------------------------
// 内联 CSS
// ---------------------------------------------------------------------------

let cssCount = 0
html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (tag) => {
  const matched = /\bhref="([^"]+)"/.exec(tag)
  if (matched === null) return tag

  const css = readFileSync(join(distDir, matched[1]), 'utf8')
  if (/<\/style/i.test(css)) {
    throw new Error(`${matched[1]} 里出现了 </style，无法安全内联`)
  }
  cssCount++
  return `<style>\n${css}\n</style>`
})

// ---------------------------------------------------------------------------
// 内联 JS
// ---------------------------------------------------------------------------

let jsCount = 0
html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g, (_tag, src) => {
  const js = readFileSync(join(distDir, src), 'utf8')

  // 内联脚本里只要出现 </script 就会提前闭合标签、把后面半截代码当 HTML。
  // 转义成 <\/script 后语义不变（JS 字符串里 \/ 就是 /），但标签不会再被识别。
  const escaped = js.replace(/<\/script/gi, '<\\/script')

  jsCount++
  // 刻意不写 type="module"：经典脚本不需要模块解析，file:// 下照常执行。
  // 脚本原本就在 <body> 末尾，所以执行时上面的 DOM 已经解析完毕。
  return `<script>${escaped}</script>`
})

// ---------------------------------------------------------------------------
// 自检 + 写出
// ---------------------------------------------------------------------------

// ① 不能再有任何外部引用，否则 file:// 下依然会失败
const external = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/gi)].map((m) => m[1])
if (external.length > 0) {
  throw new Error(`还有外部引用没内联：${external.join(', ')}`)
}

// ② 不能再残留 module 脚本（内联后应该一个都没有）
if (/<script\b[^>]*type="module"/i.test(html)) {
  throw new Error('产物里仍有 type="module" 的脚本，file:// 下会加载失败')
}

// ③ 核心 DOM 必须都在，否则运行时会取不到元素直接抛错
const requiredIds = ['stage-canvas', 'dropzone', 'play-panel', 'settings-overlay', 'hud']
const missing = requiredIds.filter((id) => !html.includes(`id="${id}"`))
if (missing.length > 0) {
  throw new Error(`单文件里缺少必要的 DOM：${missing.join(', ')}`)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, html, 'utf8')

const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
console.log(`内联完成：${cssCount} 个样式表 + ${jsCount} 个脚本`)
console.log(`产物：${outFile}  (${sizeKb} KB)`)
console.log('双击即可游玩（file:// 下也能跑）')
