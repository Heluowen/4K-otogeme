/**
 * 键盘输入管理。
 *
 * ============================ 唯一重要的事 ============================
 *
 * **时间戳必须在事件回调里当场取，绝不能等渲染帧。**
 *
 * `KeyboardEvent.timeStamp` 与 `performance.now()` 在同一条时间轴上，
 * 它是"这一次按键发生在什么时候"的唯一可信来源。如果用处理事件的那一帧的
 * 歌曲时间去判定，就会白白引入一个 0~16ms 的随机误差（帧间隔抖动），
 * 而 MAX 判定窗口只有 ±16ms —— 等于直接把最好的判定随机抹掉。
 *
 * 所以这里的职责很单纯：把键盘事件翻译成「第几轨、什么时候」，
 * 然后原样交给 Engine 去换算成歌曲时间。
 *
 * ============================ 键位可重绑 ============================
 *
 * 绑定用 `KeyboardEvent.code` 而不是 `key`。
 * `code` 表示"物理按键位置"，`key` 表示"这个键打出来的字符"。
 * 用 `key` 的话，中文输入法、大写锁定、非美式键盘布局都会让绑定失效。
 */

/** 一次按键动作 */
export interface LaneKeyEvent {
  /** 轨道号，从 0 开始 */
  lane: number
  /** 事件发生时刻（performance 时间轴，ms） */
  perfTimeMs: number
}

export interface InputHandlers {
  onPress: (event: LaneKeyEvent) => void
  onRelease: (event: LaneKeyEvent) => void
}

export class InputManager {
  private readonly handlers: InputHandlers

  /** KeyboardEvent.code → 轨道号 */
  private codeToLane = new Map<string, number>()

  /** 每条轨道当前是否按着。用来过滤重复的 keydown */
  private down: boolean[] = []

  private attached = false
  /** 被按下但还没松开的轨道，失焦时要统一松开 */
  private readonly pressedLanes = new Set<number>()

  /**
   * 输入开关。设置面板在"等待按键"时会把这里关掉 ——
   * 否则用户按下一个已经被绑定的键，会同时被捕获逻辑和游戏判定收到。
   */
  private enabled = true

  constructor(handlers: InputHandlers) {
    this.handlers = handlers
  }

  /** 开关键盘输入。关闭时会顺带把当前按着的键全部松开。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) this.releaseAll(performance.now())
  }

  /**
   * 设置按键映射。
   *
   * @param codes codes[i] 是第 i 轨的 KeyboardEvent.code。
   *              空字符串表示这一轨不绑定。
   */
  setBindings(codes: readonly string[]): void {
    this.codeToLane = new Map()
    this.down = new Array<boolean>(codes.length).fill(false)

    for (let lane = 0; lane < codes.length; lane++) {
      const code = codes[lane]
      // 同一个键绑到两条轨道时，先绑的生效 —— 后绑的会被忽略，
      // 这样即使设置数据被手改坏了也不会出现诡异行为
      if (code !== '' && !this.codeToLane.has(code)) {
        this.codeToLane.set(code, lane)
      }
    }
  }

  /** 开始监听。整个 window 级别监听，不需要焦点在某个元素上。 */
  attach(): void {
    if (this.attached) return
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    // 窗口失焦时把所有按下的键当成松开。
    // 否则"按住 A 然后 Alt+Tab 切走"会让 A 永远处于按下状态，
    // 回来之后长条一直不松、后续按键全被当成重复按下。
    window.addEventListener('blur', this.handleBlur)
    this.attached = true
  }

  /** 停止监听并松开所有按键。 */
  detach(): void {
    if (!this.attached) return
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('blur', this.handleBlur)
    this.attached = false
    // 通知外部把所有键松开，避免判定引擎里残留"正在按住的长条"
    this.releaseAll(performance.now())
  }

  /** 把当前所有按下的轨道都当作松开。暂停、失焦、切歌时调用。 */
  releaseAll(perfTimeMs: number): void {
    for (const lane of this.pressedLanes) {
      const index = lane
      if (this.down[index]) this.down[index] = false
      this.handlers.onRelease({ lane: index, perfTimeMs })
    }
    this.pressedLanes.clear()
  }

  /** 查询某条轨道此刻是否被按住，渲染层用来画按下高亮。 */
  isDown(lane: number): boolean {
    return this.down[lane] === true
  }

  // ---------------------------------------------------------------------
  // 事件处理
  // ---------------------------------------------------------------------

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    // 被临时关掉时（比如设置面板正在等用户按键）不接受任何游戏输入
    if (!this.enabled) return

    // 挡掉系统的按键重复：按住不放时浏览器会持续派发 keydown(repeat=true)，
    // 不挡的话一次长按会被当成连续几十次打击。
    if (event.repeat) return

    const lane = this.codeToLane.get(event.code)
    if (lane === undefined) return
    if (this.down[lane]) return

    this.down[lane] = true
    this.pressedLanes.add(lane)

    // 阻止默认行为，避免空格滚动页面、方向键滚动等等
    event.preventDefault()

    this.handlers.onPress({ lane, perfTimeMs: eventTimeStampOf(event) })
  }

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    const lane = this.codeToLane.get(event.code)
    if (lane === undefined) return
    if (!this.down[lane]) return

    this.down[lane] = false
    this.pressedLanes.delete(lane)
    event.preventDefault()

    this.handlers.onRelease({ lane, perfTimeMs: eventTimeStampOf(event) })
  }

  private readonly handleBlur = (): void => {
    this.releaseAll(performance.now())
  }
}

/**
 * 取事件的时间戳，并保证它是个有意义的数。
 *
 * 正常情况下 `event.timeStamp` 就是 performance 时间轴上的毫秒数。
 * 极少数环境（老浏览器、某些合成事件）会给 0，那就退回当前时刻。
 */
function eventTimeStampOf(event: KeyboardEvent): number {
  return event.timeStamp > 0 ? event.timeStamp : performance.now()
}

/**
 * 把 KeyboardEvent.code 转成界面上好认的名字。
 *
 * 直接把 'KeyD' 显示给用户太丑了，而 'Space' 之类的更需要翻译。
 */
export function formatKeyCode(code: string): string {
  if (code === '') return '未绑定'

  // 单字母：KeyD → D
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  // 主键盘数字：Digit1 → 1
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  // 小键盘数字：Numpad4 → 小键盘 4
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6)
    const numpadNames: Record<string, string> = {
      Add: '+',
      Subtract: '-',
      Multiply: '*',
      Divide: '/',
      Decimal: '.',
      Enter: '回车',
    }
    return `小键盘 ${numpadNames[rest] ?? rest}`
  }

  const named: Record<string, string> = {
    Space: '空格',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ShiftLeft: '左 Shift',
    ShiftRight: '右 Shift',
    ControlLeft: '左 Ctrl',
    ControlRight: '右 Ctrl',
    AltLeft: '左 Alt',
    AltRight: '右 Alt',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
    Enter: '回车',
    NumpadEnter: '小键盘回车',
    Tab: 'Tab',
    CapsLock: 'CapsLock',
  }

  return named[code] ?? code
}
