/**
 * 极简 ZIP 读取器（零依赖）。
 *
 * ============================ 为什么自己写 ============================
 *
 * osu 的谱面包 `.osz` 本质上就是一个改了扩展名的 zip。要读它就得解压。
 * 通常这里会引入 fflate / JSZip，但既然现代浏览器已经内置了解压能力
 * （`DecompressionStream('deflate-raw')`），自己写一个 zip 读取器只要 100 行，
 * 而且能省掉一个运行时依赖。
 *
 * ============================ ZIP 文件结构速览 ============================
 *
 * 一个 zip 从后往前是这么组织的：
 *
 *   [本地文件头1][数据1] [本地文件头2][数据2] ... [中央目录] [EOCD]
 *
 *   - EOCD（End Of Central Directory）：整个文件的目录索引，在文件最末尾。
 *     它的签名是 0x06054B50。因为 zip 允许在末尾附加注释，所以要从后往前搜。
 *   - 中央目录：每个文件一条记录，含有文件名、压缩方式、压缩后大小、
 *     以及"对应的本地文件头在文件里的偏移量"。
 *   - 本地文件头：真正的数据前面还有一个小头部。**它的文件名长度/扩展字段长度
 *     可能和中央目录里记的不一样**（比如某些打包工具只在本地头里放扩展字段），
 *     所以必须回到本地头重新读这两个长度，才能算准数据起始位置。
 */
export type ZipFiles = Map<string, Uint8Array<ArrayBuffer>>

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** EOCD 固定部分长度 */
const EOCD_SIZE = 22
/** 中央目录条目的固定部分长度 */
const CENTRAL_SIZE = 46
/** 本地文件头的固定部分长度 */
const LOCAL_SIZE = 30
/** zip 注释最大长度（存在 EOCD 的后两个字节里，是 16 位） */
const MAX_COMMENT_SIZE = 0xffff

/** ZIP 里的 32 位溢出标记，出现它说明用到了 Zip64 扩展 */
const ZIP64_MARK = 0xffffffff

/**
 * 解压整个 zip。
 *
 * @param buffer 整个 zip 文件的二进制内容
 * @returns 文件名 → 文件内容。目录条目会被跳过。
 */
export async function readZip(buffer: ArrayBuffer): Promise<ZipFiles> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  const eocd = findEndOfCentralDirectory(view, buffer.byteLength)
  const entryCount = view.getUint16(eocd + 10, true)
  const centralOffset = view.getUint32(eocd + 16, true)

  // Zip64 只在单个文件超过 4GB 或条目数超过 65535 时才会用到。
  // .osz 永远到不了这个量级，直接明确报错比默默读出乱码好。
  if (centralOffset === ZIP64_MARK || entryCount === 0xffff) {
    throw new Error('这个压缩包使用了 Zip64 扩展，暂不支持')
  }

  const files: ZipFiles = new Map()
  let cursor = centralOffset

  for (let i = 0; i < entryCount; i++) {
    if (cursor + CENTRAL_SIZE > buffer.byteLength || view.getUint32(cursor, true) !== SIG_CENTRAL) {
      throw new Error('压缩包的中央目录结构损坏')
    }

    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)

    // 文件名紧跟固定部分。osu 打包出来的 zip 用的是 UTF-8
    // （严格来说要看"通用位标记"第 11 位，但实际遇到的 .osz 都是 UTF-8）。
    const name = UTF8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))

    // 移动到下一条中央目录记录
    cursor += CENTRAL_SIZE + nameLength + extraLength + commentLength

    // 目录条目（以 / 结尾）没有内容，跳过
    if (name.endsWith('/')) continue
    if (compressedSize === ZIP64_MARK || localOffset === ZIP64_MARK) {
      throw new Error(`"${name}" 使用了 Zip64 扩展，暂不支持`)
    }

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new Error(`"${name}" 的本地文件头无效，压缩包可能已损坏`)
    }

    // 关键：重新读本地头里的名字长度和扩展字段长度。
    // 它和中央目录里的值不一定相同，用错就会把数据的起始位置算偏。
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + LOCAL_SIZE + localNameLength + localExtraLength

    const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
    files.set(name, await inflate(compressed, method))
  }

  return files
}

/**
 * 从文件末尾往前找 EOCD 记录。
 * 之所以要搜而不是直接读最后 22 字节，是因为 zip 允许在 EOCD 之后附加最多 64KB 注释。
 */
function findEndOfCentralDirectory(view: DataView, byteLength: number): number {
  const lowest = Math.max(0, byteLength - EOCD_SIZE - MAX_COMMENT_SIZE)
  for (let i = byteLength - EOCD_SIZE; i >= lowest; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i
  }
  throw new Error('这不是一个有效的压缩包（找不到 EOCD 记录）')
}

/** 按压缩方式解压一段数据。 */
// 注意参数类型写成 `Uint8Array<ArrayBuffer>` 而不是裸的 `Uint8Array`：
// 从 TypeScript 5.7 起类型化数组带上了 buffer 类型参数，裸写会退化成
// `Uint8Array<ArrayBufferLike>`，而它可能指向 SharedArrayBuffer，
// 于是没法直接喂给 Blob()。这里明确要求是普通 ArrayBuffer 上的视图，
// 既通过类型检查，也不需要为了迎合类型而多拷贝一份数据。
async function inflate(data: Uint8Array<ArrayBuffer>, method: number): Promise<Uint8Array<ArrayBuffer>> {
  // 0 = 存储（没有压缩），直接拷贝一份。
  // 注意必须拷贝：`data` 只是整个 zip 大 buffer 上的一个视图，
  // 直接返回它会让整个 zip 的内存一直被引用着，无法释放。
  if (method === 0) return data.slice()

  // 8 = deflate。`deflate-raw` 表示裸 deflate 流（没有 zlib/gzip 的头和校验），
  // 这正是 zip 内部使用的格式。
  if (method !== 8) {
    throw new Error(`不支持的压缩方式 ${method}（只支持 0=存储、8=deflate）`)
  }

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 复用一个 TextDecoder 实例，避免每个文件名都新建一个 */
const UTF8 = new TextDecoder('utf-8')
