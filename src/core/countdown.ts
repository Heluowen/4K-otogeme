/**
 * 准备倒计时的进位逻辑。
 *
 * 单独放一个文件（而不是塞在 render/canvas.ts 里）有两个原因：
 *
 *   1. 它是纯计算，和画布半点关系都没有，放在 core/ 才对得上分层；
 *
 *   2. core/ 下的模块除了类型不引入任何运行时依赖，所以 Node 能直接加载它做单元测试。
 *      而 render/canvas.ts 里有一句没写扩展名的 `import ... from '../core/judge'` ——
 *      Vite 能解析，Node 的 ESM 加载器不行，所以那个文件在 Node 里是 import 不进来的。
 *
 * 为什么值得单独拎出来：倒计时的进位最容易差一位，
 * 典型症状是「3 跳到 2 的瞬间闪一下 1」，肉眼很难复现、但玩起来很别扭。
 */

/** 倒计时当前这一拍的状态 */
export interface CountdownTick {
  /** 要显示的数字：3、2、1 */
  seconds: number
  /** 当前这个数字已经显示了多久：0 = 刚跳到它，1 = 马上就要跳到下一个 */
  progress: number
}

/**
 * 把「距离歌曲第 0ms 还剩多久」换算成倒计时显示需要的东西。
 *
 * @param remainingMs 剩余毫秒数，必须是正数（调用方负责过滤掉 <= 0 的情况）
 */
export function countdownTick(remainingMs: number): CountdownTick {
  // 向上取整：剩 3000ms 显示 3，剩 2000ms 显示 2，剩 1ms 显示 1
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000))

  // 例：remainingMs = 2500 → seconds = 3 → (2500 - 2000) / 1000 = 0.5 → progress = 0.5
  //     remainingMs = 2000 → seconds = 2 → (2000 - 1000) / 1000 = 1.0 → progress = 0
  //     也就是每个数字都是"刚跳过去时 progress 为 0，持续到 1 再进位"。
  const progress = Math.min(1, Math.max(0, 1 - (remainingMs - (seconds - 1) * 1000) / 1000))

  return { seconds, progress }
}
