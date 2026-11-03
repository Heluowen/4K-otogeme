import { defineConfig } from 'vite'

/**
 * Vite 配置。
 * 这个项目本身不需要任何 Vite 插件，ES 模块 + TypeScript 开箱即用。
 */
export default defineConfig({
  /**
   * 资源路径用**相对**形式（./assets/...）而不是默认的绝对形式（/assets/...）。
   *
   * 默认的绝对路径要求产物必须挂在域名**根目录**下，放到子目录里就白屏 ——
   * 而这个项目的产物是要打成 zip 分发出去的，别人解压到哪儿都有可能。
   */
  base: './',

  server: {
    port: 5173,
    // 启动后自动打开浏览器，省一次手动点链接
    open: true,
  },

  build: {
    // 我们用到了 DecompressionStream 等较新的浏览器 API，
    // 把构建目标定在 ES2022，避免 Vite 把代码降级到老语法。
    target: 'es2022',
  },
})
