/**
 * 极简静态文件服务器（零依赖，只用 Node 内置模块）。
 *
 * ============================ 它解决什么问题 ============================
 *
 * 双击 `index.html` 打开时浏览器给的是 `file://` 协议，那个协议下：
 *   - ES 模块加载会被 CORS 拦掉（所以只能发内联版本）
 *   - File System Access API 直接不可用（保存谱面到磁盘没了）
 *   - IndexedDB / localStorage 可能被禁（谱面存档、设置全丢）
 *
 * 换成 `http://localhost` 之后这些全都正常 —— 而"起一个服务器"这件事
 * 不该要求用户会 npm。所以这个文件只有 Node 内置模块，双击 `start.bat` 就能跑。
 *
 * ============================ 用法 ============================
 *
 *   node server.mjs              服务本文件所在目录
 *   node server.mjs ./some/dir   服务指定目录
 *   PORT=9000 node server.mjs    指定起始端口
 *
 * 端口被占用时会自动往后找一个空的，然后自动打开浏览器。
 */

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 要服务的根目录：优先用命令行参数，否则就是本脚本所在目录 */
const rootDir =
  process.argv[2] !== undefined
    ? resolve(process.argv[2])
    : dirname(fileURLToPath(import.meta.url))

/** 起始端口。8080 很少被占，而且不和开发服务器的 5173 冲突 */
const startPort = Number(process.env.PORT ?? 8080)
/** 端口被占用时最多往后试这么多个 */
const maxPortTries = 10

/** 只列这个项目实际会用到的类型。MIME 给错的话浏览器会拒绝执行脚本/样式。 */
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}

const server = createServer(async (request, response) => {
  let pathname = '/'
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    send(response, 400, 'text/plain; charset=utf-8', 'Bad Request')
    return
  }

  // 去掉开头的斜杠再拼到根目录上。join 会顺带规范化掉 `..` 之类的段。
  let filePath = join(rootDir, pathname.replace(/^\/+/, ''))

  // 防目录穿越：拼完之后必须仍然落在根目录里，否则 `../../etc/passwd` 就能读到外面
  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    send(response, 403, 'text/plain; charset=utf-8', 'Forbidden')
    return
  }

  try {
    const info = await stat(filePath)
    if (info.isDirectory()) filePath = join(filePath, 'index.html')
  } catch {
    // 文件不存在，下面 readFile 会再报一次，这里不用管
  }

  try {
    const data = await readFile(filePath)
    send(
      response,
      200,
      mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      data,
    )
  } catch {
    send(response, 404, 'text/plain; charset=utf-8', `Not Found: ${pathname}`)
  }
})

function send(response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    // 别缓存：改了文件刷新就该看到，不然排查问题时会怀疑人生
    'Cache-Control': 'no-cache',
  })
  response.end(body)
}

/** 试着监听某个端口，成功就 resolve，占用则 reject 掉 EADDRINUSE */
function tryListen(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => rejectPromise(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolvePromise(port)
    })
  })
}

/** 用系统默认浏览器打开地址。打不开也没关系，地址已经打印在控制台了。 */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 忽略
  }
}

let listeningPort = null
for (let attempt = 0; attempt < maxPortTries; attempt++) {
  try {
    listeningPort = await tryListen(startPort + attempt)
    break
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      console.error(`Failed to start: ${error.message}`)
      process.exit(1)
    }
  }
}

if (listeningPort === null) {
  console.error(`Ports ${startPort}..${startPort + maxPortTries - 1} are all in use.`)
  process.exit(1)
}

const pageUrl = `http://127.0.0.1:${listeningPort}/`

// ⚠️ 这里的输出刻意全用 ASCII。
// Windows 的 cmd.exe 按系统 OEM 代码页（简中是 936/GBK）解释控制台字节，
// 而 Node 输出的是 UTF-8 —— 中文会变成一串乱码问号。
// 说明性文字放在 README.txt 里（那个用 UTF-8 存，记事本读得对）。
console.log('')
console.log('  rhythm-4k is running')
console.log('')
console.log(`  ${pageUrl}`)
console.log('')
console.log(`  Serving: ${rootDir}`)
console.log('  Close this window to stop the server.')
console.log('')

// 自动化测试/无头环境里不想被自动弹浏览器时，设 NO_OPEN=1
if (process.env.NO_OPEN !== '1') {
  openBrowser(pageUrl)
}
