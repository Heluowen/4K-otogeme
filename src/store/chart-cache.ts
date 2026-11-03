/**
 * 谱面包缓存（IndexedDB）。
 *
 * ============================ 存什么 ============================
 *
 * 存**压缩包的原始字节**，而不是解析后的谱面 + 解码后的音频。原因：
 *   1. 体积最小 —— .osz 本来就是压缩过的，展开成 PCM 音频要大几十倍；
 *   2. 解析器以后改进了，缓存里的条目自动跟着受益，不需要清缓存；
 *   3. 读取时重跑一遍 unzip + parse 只要几十毫秒，完全不值得为它做复杂的事。
 *
 * ============================ 为什么用两个 object store ============================
 *
 * 这是 IndexedDB 一个很容易踩的坑：**读记录时整个 value 都会被反序列化**。
 * 如果元信息和几十 MB 的 ArrayBuffer 放在同一条记录里，那么为了列出
 * 「最近导入」而遍历一遍 store，就会把所有谱面包的字节全部读进内存。
 *
 * 所以拆成两张表：
 *   - chartSetMeta  ：只有名字、大小、时间戳，列表页只读这张，非常便宜
 *   - chartSetBlobs ：真正的字节，只在用户真的点开某一条时才读
 *
 * 两张表用同一个主键（文件名），删除时在同一个事务里一起删。
 *
 * ============================ 失败策略 ============================
 *
 * 缓存是**锦上添花**。隐私模式、配额不足、浏览器禁用了 IndexedDB ——
 * 这些情况下缓存必须安静地降级成"没有缓存"，绝对不能影响正常的导入和游玩。
 * 所以这里所有公开函数都不向上抛异常，而是返回空值 / false。
 */

/** 数据库名 */
const DB_NAME = 'rhythm-4k'
/** 结构版本。以后改表结构时把它 +1，并在 onupgradeneeded 里写迁移逻辑 */
const DB_VERSION = 1
const META_STORE = 'chartSetMeta'
const BLOB_STORE = 'chartSetBlobs'

/** 单个谱面包超过这个大小就不缓存了（谱面包里塞视频的情况很常见） */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** 缓存总字节上限，超过就淘汰最旧的 */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
/** 最多保留多少个谱面包 */
const MAX_ENTRIES = 20

/** 元信息记录（存在 chartSetMeta 里） */
interface CachedChartSetMeta {
  /** 文件名，同时是主键 */
  name: string
  /** 压缩包字节数 */
  size: number
  /** 导入时间戳（ms） */
  savedAt: number
}

/** 缓存条目的元信息，给界面用（不含字节） */
export interface CachedChartSetInfo {
  name: string
  size: number
  savedAt: number
}

/** 完整缓存条目（含字节） */
export interface CachedChartSet extends CachedChartSetInfo {
  data: ArrayBuffer
}

/** 存储用量 */
export interface StorageUsage {
  usage: number
  quota: number
}

// ---------------------------------------------------------------------------
// 连接管理
// ---------------------------------------------------------------------------

/** 缓存起来的数据库连接。整个页面复用一条连接，不要每次操作都 open 一次。 */
let databasePromise: Promise<IDBDatabase> | null = null

/** IndexedDB 在当前环境是否可用。隐私模式、老浏览器、被策略禁用时都可能没有。 */
function isAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function database(): Promise<IDBDatabase> {
  if (databasePromise !== null) return databasePromise

  databasePromise = openDatabase().catch((error: unknown) => {
    // 打开失败时不要把失败的 Promise 缓存下来，否则之后永远好不了
    databasePromise = null
    throw error
  })
  return databasePromise
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      // 只在第一次创建（或版本升级）时建表
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'name' })
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE, { keyPath: 'name' })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // 用户在另一个标签页里升级了版本时，这条连接必须让路，否则会阻塞对方。
      // 关掉之后 databasePromise 会在下次访问时重新建立连接。
      db.onversionchange = () => {
        db.close()
        databasePromise = null
      }
      resolve(db)
    }

    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'))
    // 另一个标签页占着旧版本的连接时会被阻塞在这里。
    // 与其一直挂着不如明确失败 —— 反正缓存本来就是可有可无的。
    request.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'))
  })
}

/** 把 IDBRequest 包成 Promise。 */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

/**
 * 等事务真正提交完成。
 *
 * 只等 request 的 success 是不够的 —— 那时数据可能还没落盘。
 * 写入之后紧接着读（或者立刻关页面）时，这个区别会很明显。
 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务被中止'))
  })
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/**
 * 列出所有缓存条目，**按导入时间升序**（最旧的在前）。
 *
 * 只读元信息表，所以即使缓存了 20 个几十 MB 的谱面包，这个调用也很轻。
 */
export async function listCachedSets(): Promise<CachedChartSetInfo[]> {
  if (!isAvailable()) return []

  try {
    const db = await database()
    const transaction = db.transaction(META_STORE, 'readonly')
    const records = (await requestToPromise(
      transaction.objectStore(META_STORE).getAll(),
    )) as unknown[]

    return records
      .filter((record): record is CachedChartSetMeta => {
        const candidate = record as Partial<CachedChartSetMeta> | null
        return (
          typeof candidate === 'object' &&
          candidate !== null &&
          typeof candidate.name === 'string' &&
          typeof candidate.savedAt === 'number'
        )
      })
      .sort((a, b) => a.savedAt - b.savedAt)
      .map((record) => ({
        name: record.name,
        size: typeof record.size === 'number' ? record.size : 0,
        savedAt: record.savedAt,
      }))
  } catch {
    return []
  }
}

/** 读取一条完整缓存。找不到或读坏了都返回 null。 */
export async function readCachedSet(name: string): Promise<CachedChartSet | null> {
  if (!isAvailable()) return null

  try {
    const db = await database()
    const transaction = db.transaction([META_STORE, BLOB_STORE], 'readonly')

    // 两个请求要在同一个事务里、并且在 await 之前就发出去。
    // 一旦 await，事务就可能因为没有待处理请求而自动提交。
    const metaRequest = requestToPromise(transaction.objectStore(META_STORE).get(name))
    const blobRequest = requestToPromise(transaction.objectStore(BLOB_STORE).get(name))

    const meta = (await metaRequest) as CachedChartSetMeta | undefined
    const blob = (await blobRequest) as { data?: unknown } | undefined

    if (meta === undefined || blob === undefined) return null

    const data = toArrayBuffer(blob.data)
    if (data === null) return null

    return { name: meta.name, size: meta.size, savedAt: meta.savedAt, data }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/**
 * 把一份谱面包存进缓存。
 *
 * @returns true 表示确实存进去了；false 表示被跳过（太大 / 环境不支持 / 配额不足）。
 */
export async function saveCachedSet(name: string, data: ArrayBuffer): Promise<boolean> {
  if (!isAvailable()) return false
  // 单个文件太大就干脆不缓存：留着它会挤掉好几个正常大小的谱面包
  if (data.byteLength > MAX_ENTRY_BYTES) return false
  if (name === '') return false

  try {
    await writeSet(name, data)
  } catch (error) {
    // 大概率是配额满了。清掉一半最旧的再试一次。
    if (!isQuotaError(error)) return false
    try {
      const list = await listCachedSets()
      const half = list.slice(0, Math.ceil(list.length / 2)).map((item) => item.name)
      await deleteCachedSets(half)
      await writeSet(name, data)
    } catch {
      return false
    }
  }

  // 写成功之后再收紧总量。清理失败不影响已经写进去的数据。
  await enforceLimits()
  return true
}

async function writeSet(name: string, data: ArrayBuffer): Promise<void> {
  const db = await database()
  const transaction = db.transaction([META_STORE, BLOB_STORE], 'readwrite')

  const meta: CachedChartSetMeta = { name, size: data.byteLength, savedAt: Date.now() }
  transaction.objectStore(META_STORE).put(meta)
  // ArrayBuffer 可以直接被结构化克隆存进去；读取时再原样拿回来
  transaction.objectStore(BLOB_STORE).put({ name, data })

  await transactionDone(transaction)
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

/** 删除一条缓存。 */
export async function deleteCachedSet(name: string): Promise<void> {
  await deleteCachedSets([name])
}

/** 一次删掉多条缓存（同一个事务里完成）。 */
async function deleteCachedSets(names: readonly string[]): Promise<void> {
  if (!isAvailable() || names.length === 0) return

  const db = await database()
  const transaction = db.transaction([META_STORE, BLOB_STORE], 'readwrite')
  const metaStore = transaction.objectStore(META_STORE)
  const blobStore = transaction.objectStore(BLOB_STORE)

  for (const name of names) {
    metaStore.delete(name)
    blobStore.delete(name)
  }

  await transactionDone(transaction)
}

/** 清空全部缓存。 */
export async function clearCachedSets(): Promise<void> {
  if (!isAvailable()) return

  try {
    const db = await database()
    const transaction = db.transaction([META_STORE, BLOB_STORE], 'readwrite')
    transaction.objectStore(META_STORE).clear()
    transaction.objectStore(BLOB_STORE).clear()
    await transactionDone(transaction)
  } catch {
    // 清不掉就算了，不值得为此报错打扰用户
  }
}

// ---------------------------------------------------------------------------
// 容量控制
// ---------------------------------------------------------------------------

/** 按 LRU 收紧缓存总量。 */
async function enforceLimits(): Promise<void> {
  try {
    const list = await listCachedSets()
    const doomed = planEviction(list, MAX_TOTAL_BYTES, MAX_ENTRIES)
    await deleteCachedSets(doomed)
  } catch {
    // 清理失败不影响已经写进去的数据
  }
}

/**
 * 决定要淘汰哪些条目。
 *
 * 抽成纯函数是为了能单独测试 —— 它是这个模块里唯一有分支逻辑的部分。
 *
 * @param list          缓存列表，**必须按 savedAt 升序**（最旧的在前）
 * @param maxTotalBytes 总字节预算
 * @param maxEntries    条目数上限
 * @returns 需要删除的文件名（同样是最旧的在前）
 */
export function planEviction(
  list: readonly CachedChartSetInfo[],
  maxTotalBytes: number,
  maxEntries: number,
): string[] {
  const doomed: string[] = []

  let totalBytes = 0
  for (const item of list) totalBytes += item.size

  let remaining = list.length
  for (const item of list) {
    // 两条预算都满足就停手
    if (remaining <= maxEntries && totalBytes <= maxTotalBytes) break
    doomed.push(item.name)
    totalBytes -= item.size
    remaining--
  }

  return doomed
}

/** 查询浏览器给的存储配额，界面上显示用。拿不到就返回 null。 */
export async function estimateUsage(): Promise<StorageUsage | null> {
  // 某些环境（Node、隐私模式、被策略禁用）整个 navigator 或 storage 都可能不存在。
  // 这里显式标注类型，避免 TS 把 typeof 判断后的分支收窄成 never。
  const storage: StorageManager | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.storage
  if (storage === undefined || typeof storage.estimate !== 'function') return null

  try {
    const estimate = await storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 判断异常是不是"配额不足"。 */
function isQuotaError(error: unknown): boolean {
  if (typeof DOMException === 'undefined') return false
  if (!(error instanceof DOMException)) return false
  return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

/**
 * 把存进去的东西还原成 ArrayBuffer。
 *
 * 按规范 ArrayBuffer 会被原样克隆回来，但个别实现会还原成类型化数组视图，
 * 所以这里两种都接受。转换时**必须拷贝**而不是直接取 `.buffer` ——
 * 视图可能只是某个更大 buffer 上的一小段。
 */
function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    const copy = new ArrayBuffer(view.byteLength)
    new Uint8Array(copy).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    return copy
  }

  return null
}
