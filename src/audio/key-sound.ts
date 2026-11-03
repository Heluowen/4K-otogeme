/**
 * 按键音。
 *
 * 完全用 Web Audio **现场合成**，不加载任何音频文件 ——
 * 一个 70ms 的衰减正弦就够用了，不值得为它引入一个资源文件，
 * 而且合成出来的声音没有解码延迟，天生就更快。
 *
 * ============================ 延迟是这个功能唯一重点 ============================
 *
 * 声音必须在 keydown 回调里**当场**播放，绝不能等下一帧再统一处理。
 * 等一帧就是最多 16ms 的额外延迟，而"按下到出声"的延迟是人耳最敏感的东西之一 ——
 * 这也是为什么它绑在"按键"而不是"命中"上：这是键盘反馈，不是判定反馈。
 *
 * 具体到代码上有两处必须注意：
 *   1. `source.start()` 不传参数（= 立刻播放）。传 `ctx.currentTime` 反而会多走一层
 *      排期逻辑，那点排期在音乐上是必要的，在按键音上是纯损耗。
 *   2. 增益用一条常驻的 GainNode 控制，而不是每次重新生成 buffer ——
 *      调音量时不该有任何重建开销。
 */
export class KeySound {
  private readonly ctx: AudioContext
  /** 常驻的音量节点。之所以不让每条音源各带一个增益，是为了调音量时零开销。 */
  private readonly gain: GainNode

  /** 每条轨道一个音高，按需生成并缓存（同一轨的 buffer 只生成一次） */
  private readonly buffers = new Map<number, AudioBuffer>()

  private enabled = true
  private volume = 0.7

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.gain = ctx.createGain()
    this.gain.gain.value = this.volume
    this.gain.connect(ctx.destination)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** @param volume 0..1 */
  setVolume(volume: number): void {
    this.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0
    this.gain.gain.value = this.volume
  }

  /**
   * 播放某条轨道的按键音。
   *
   * 这个方法跑在键盘事件回调里，必须足够快 ——
   * 里面只做一次 Map 查询和一次 createBufferSource。
   */
  play(lane: number): void {
    if (!this.enabled || this.volume <= 0) return

    const source = this.ctx.createBufferSource()
    source.buffer = this.bufferFor(lane)
    source.connect(this.gain)
    // 不传参数 = 立刻开始
    source.start()
    // 播完之后浏览器会自己回收这个节点，不需要手动 disconnect
  }

  /** 取某条轨道的音色，没有就生成一个并缓存。 */
  private bufferFor(lane: number): AudioBuffer {
    const key = Math.max(0, Math.floor(lane))
    const cached = this.buffers.get(key)
    if (cached !== undefined) return cached

    const buffer = createTapBuffer(this.ctx, key)
    this.buffers.set(key, buffer)
    return buffer
  }
}

// ---------------------------------------------------------------------------
// 音色合成
// ---------------------------------------------------------------------------

/**
 * 音高用的五声音阶（相对根音的半音数）。
 *
 * 用五声音阶而不是半音阶，是因为几条轨道经常会被同时按下（和弦、连打），
 * 五声音阶里任意几个音一起响都不会难听。半音阶相邻的音一起响会非常浑浊。
 */
const PENTATONIC_SEMITONES = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]

/** 根音频率（Hz）。A4 = 440 */
const ROOT_FREQUENCY = 440

/** 单次敲击的时长（秒）。够短才能跟得上高速连打。 */
const TAP_DURATION_SEC = 0.07

/** 起音斜坡时长（秒） */
const ATTACK_SEC = 0.001

/**
 * 合成一个"敲击"音色。
 *
 * 结构：指数衰减包络 × （基频 + 两个泛音）。
 * 加泛音是为了让它听起来像"敲"而不是"哔"——纯正弦的电子味太重。
 */
function createTapBuffer(ctx: AudioContext, lane: number): AudioBuffer {
  const sampleRate = ctx.sampleRate
  const length = Math.max(1, Math.round(sampleRate * TAP_DURATION_SEC))
  const buffer = ctx.createBuffer(1, length, sampleRate)
  const data = buffer.getChannelData(0)

  const semitone = PENTATONIC_SEMITONES[lane % PENTATONIC_SEMITONES.length]
  const frequency = ROOT_FREQUENCY * Math.pow(2, semitone / 12)

  // 衰减速度：音越高收得越快，听感上更像敲击而不是"嘟——"
  const decayRate = 55 + semitone * 2.2

  const attackSamples = Math.max(1, Math.round(sampleRate * ATTACK_SEC))

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate

    const envelope = Math.exp(-t * decayRate)

    // 基频 + 八度泛音 + 十二度泛音。三个分量加起来峰值正好是 1.0。
    const tone =
      Math.sin(2 * Math.PI * frequency * t) * 0.66 +
      Math.sin(2 * Math.PI * frequency * 2 * t) * 0.24 +
      Math.sin(2 * Math.PI * frequency * 3 * t) * 0.1

    // 从 0 直接跳到振幅会在扬声器上"啪"一声 ——
    // 那不是我们要的敲击声，那是直流跳变造成的爆音。
    // 1ms 的起音斜坡短到听不出来，但足以消掉它。
    const attack = i < attackSamples ? i / attackSamples : 1

    data[i] = tone * envelope * attack * 0.55
  }

  return buffer
}
