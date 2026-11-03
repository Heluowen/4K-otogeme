/**
 * 组装「自带静态服务器」的发布包：`dist-server/`
 *
 * 产物结构：
 *
 *   dist-server/
 *   ├─ index.html        ← 构建产物
 *   ├─ assets/           ← 构建产物
 *   ├─ server.mjs        ← 零依赖静态服务器
 *   ├─ start.bat         ← 双击启动（自动开浏览器）
 *   └─ README.txt        ← 使用说明
 *
 * 为什么要带服务器：`file://` 下 ES 模块加载被 CORS 拦掉（白屏），
 * 而且 File System Access API / localStorage / IndexedDB 都可能不可用。
 * 换成 `http://127.0.0.1` 之后这些全都正常.
 */

import { cpSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = dirname(fileURLToPath(import.meta.url))
const projectDir = join(toolsDir, '..')
const distDir = join(projectDir, 'dist')
const outDir = join(projectDir, 'dist-server')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// ① 构建产物原样拷进去，index.html 直接落在包根目录
cpSync(distDir, outDir, { recursive: true })

// ② 服务器本体：改名为 server.mjs 放根目录，start.bat 会去跑它
copyFileSync(join(toolsDir, 'serve-static.mjs'), join(outDir, 'server.mjs'))

// ③ 启动器
//
// ⚠️ 内容必须**纯 ASCII**，并且用 CRLF 换行。
// Windows 的 cmd.exe 是按系统 OEM 代码页读 .bat 的，中文在 UTF-8 文件里会被
// 按 GBK 解释成乱码 —— 轻则显示成方块，重则把后面的命令一起吞掉。
// （这个坑在 tools/make-fixture.ps1 上已经踩过一次了。）
const startBat = `@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo.
  echo   Please install Node.js 18 or newer: https://nodejs.org/
  echo   After installing, run start.bat again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting local server...
echo   Close this window to stop it.
echo.

node server.mjs
pause
`.replace(/\r?\n/g, '\r\n')

writeFileSync(join(outDir, 'start.bat'), startBat, 'ascii')

// ④ 使用说明（这个是 .txt，用 UTF-8 没问题）
const readme = `rhythm-4k —— 浏览器端 4K 下落式音游
======================================

【怎么运行】

  双击 start.bat

  会自动打开浏览器（地址类似 http://127.0.0.1:8080/）。
  关闭那个黑色命令行窗口即可停止服务器。

  需要 Node.js 18 或更高版本：https://nodejs.org/
  提示找不到 node 的话，就是没装、或者没加进 PATH。


【为什么不直接双击 index.html】

  file:// 协议下浏览器会禁掉这几样东西：
    - ES 模块加载        → 页面直接白屏
    - File System Access → 不能把谱面存进磁盘文件夹
    - localStorage / IndexedDB → 可能被禁，设置和存档会丢

  换成本地服务器之后这些全部正常。所以这个包才要带 start.bat。


【怎么玩】

  1. 打开页面后，把一个 .osz 谱面包拖进去（也可以点拖放区选文件）
  2. 选一个难度
  3. 按键默认是 D F J K，可以在「设置 → 按键映射」里改成任意键

  只支持 osu!mania 谱面（Mode: 3）。
  osu!std / taiko / catch 的谱面会被自动过滤掉。


【把谱面存到磁盘（可选）】

  导入页面下方点「选择文件夹」，选一个空目录。
  浏览器会问一次读写权限，允许之后，导入的 .osz 会自动存进那个文件夹，
  刷新页面列表也能直接读回来。

  注意 Chrome 出于安全考虑，每次重新打开页面都会要求再确认一次权限。


【常见问题】

  Q: 端口被占用？
  A: 不用管。服务器会自动往后找一个空闲端口，看命令行窗口打印的地址即可。

  Q: 提示找不到 node？
  A: 装 Node.js 18+（https://nodejs.org/），装完重新双击 start.bat。

  Q: 没有声音？
  A: 浏览器要求先有一次用户操作才允许播音频。点一下页面任意位置再按播放。

  Q: 拖进去报「没有 osu!mania 谱面」？
  A: 这个游戏只支持 mania 模式，不支持 osu!std / taiko / catch。

  Q: 音频解码失败？
  A: 少数格式（比如 flac）部分浏览器不支持，换成 .ogg / .mp3 试试。


【更多】

  源码与完整文档：https://github.com/Heluowen/4K-otogeme
`

writeFileSync(join(outDir, 'README.txt'), readme, 'utf8')

console.log('打包完成：dist-server/')
console.log('  index.html + assets/  （构建产物）')
console.log('  server.mjs            （零依赖静态服务器）')
console.log('  start.bat             （双击启动）')
console.log('  README.txt            （使用说明）')
console.log('双击 start.bat 即可游玩')
