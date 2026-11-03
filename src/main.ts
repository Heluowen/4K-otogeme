import './style.css'
// 设置面板和结算面板的样式单独放一份，它们和主流程的布局没有关系
import './ui/panels.css'
import { startApp } from './ui/app'

/**
 * 应用入口。
 *
 * 真正的装配逻辑在 ui/app.ts 里。
 * Vite 会以这个文件为起点，顺着 import 把整棵依赖树打包起来。
 */
startApp()
