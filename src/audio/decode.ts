/** 浏览器能解码的音频扩展名（不含点，全小写）。 */
const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac']

/** 根据文件名猜它是不是音频。 */
export function isAudioFileName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
}

/**
 * 把一段音频字节解码成 `AudioBuffer`。
 *
 * 解出来的 AudioBuffer 已经把整首歌展开成 PCM 放在内存里（float32，双声道的话
 * 大约每分钟 20MB 左右），换来的是可以任意时刻精确调度播放 —— 这是音游必须付的代价。
 */
export async function decodeAudio(ctx: AudioContext, bytes: Uint8Array): Promise<AudioBuffer> {
  // ⚠️ `decodeAudioData` 会「吃掉」传进去的 ArrayBuffer（detach，之后这个 buffer 就空了）。
  // 而我们的 bytes 通常只是整个 zip 大 buffer 上的一个视图，直接传它会有两个问题：
  //   ① 解码器会拿到整个 zip（包含其它无关文件）；
  //   ② zip 的 buffer 被掏空后，再去读包里别的文件就全是 0 了。
  // 所以必须先切出一份独立的拷贝。
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)

  return await ctx.decodeAudioData(copy)
}
