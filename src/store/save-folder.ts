/**
 * 谱面包的「存档文件夹」。
 *
 * ============================ 为什么需要它 ============================
 *
 * 浏览器的沙箱里，网页**不能**写入任意本地路径。想让导入的 .osz 真正落到磁盘上
 * 某个文件夹（比如工作区里的 `save/`），唯一可行的办法是 File System Access API：
 * 由用户手动选一次文件夹并授权，之后就能往里读写。
 *
 * 注意「剪切」这个词在这里做不到 —— 浏览器既不知道源文件在哪，也没有权限删它。
 * 实际行为是**往存档文件夹里写一份**。
 *
 * ============================ 目录句柄存在哪 ============================
 *
 * 句柄（directory handle）是可结构化克隆的对象，只能存 IndexedDB。
 * 但它只是一条几十字节的记录，**完全不占谱面体积** —— 谱面本体全在磁盘上。
 * 这也是这个模块唯一还碰 IndexedDB 的地方。
 *
 * ============================ 权限 ============================
 *
 * Chrome 对写入权限很谨慎：句柄能跨会话记住，但写入权限通常每次重新打开页面
 * 都要再确认一次，而且 **requestPermission 必须在用户手势里调用**。
 * 所以「恢复句柄」和「申请权限」被拆成了两个函数，由界面分别调用。
 *
 * ============================ 类型声明为什么自己写 ============================
 *
 * File System Access API 还没有进入 TypeScript 的 lib.dom（或者只进了一部分，
 * 不同 TS 版本覆盖程度还不一样）。与其依赖版本，不如只声明我们真正用到的那几个成员，
 * 再在边界处做一次类型断言 —— 这样升级 TypeScript 也不会突然编译不过。
 */

/** 我们用到的最小句柄接口 */
interface SaveHandleBase {
  readonly kind: 'file' | 'directory'
  readonly name: string
}

/** 可写文件的句柄需要的最小接口 */
interface SaveWritable {
  write(data: ArrayBuffer | ArrayBufferView | Blob | string): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

export interface SaveFileHandle extends SaveHandleBase {
  readonly kind: 'file'
  getFile(): Promise<File>
  createWritable(options?: { keepExistingData?: boolean }): Promise<SaveWritable>
}

/** 目录句柄需要的最小接口。权限相关的方法是可选的 —— 实现里不一定有。 */
export interface SaveDirectoryHandle extends SaveHandleBase {
  readonly kind: 'directory'
  values(): AsyncIterableIterator<SaveHandleBase>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SaveFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  queryPermission?(descriptor?: { mode?: string }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: string }): Promise<PermissionState>
}

/** 挂载 showDirectoryPicker 的 window 形状 */
interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
  }) => Promise<SaveDirectoryHandle>
}

/** 列表里的一项 */
export interface SavedChartFile {
  name: string
  size: number
  /** 最后修改时间（ms） */
  modifiedAt: number
  handle: SaveFileHandle
}

/** 存档文件夹的当前状态 */
export interface SaveFolderStatus {
  /** 浏览器是否支持目录授权 */
  supported: boolean
  /** 文件夹名；null 表示还没选过 */
  name: string | null
  /** 是否有写入权限（没有的话需要用户点一下重新授权） */
  writable: boolean
}

// ---------------------------------------------------------------------------
// 环境探测
// ---------------------------------------------------------------------------

function directoryPicker(): DirectoryPickerWindow['showDirectoryPicker'] | undefined {
  return (window as unknown as DirectoryPickerWindow).showDirectoryPicker
}

/** 当前浏览器是否支持选择文件夹（Chrome / Edge 支持，Firefox / Safari 不支持）。 */
export function isSaveFolderSupported(): boolean {
  return typeof directoryPicker() === 'function'
}

// ---------------------------------------------------------------------------
// 当前文件夹
// ---------------------------------------------------------------------------

let folderHandle: SaveDirectoryHandle | null = null

/** 当前文件夹名；还没选过返回 null。 */
export function getSaveFolderName(): string | null {
  return folderHandle === null ? null : folderHandle.name
}

/** 是否有写入权限。 */
export async function isSaveFolderWritable(): Promise<boolean> {
  if (folderHandle === null) return false
  return (await queryPermission(folderHandle)) === 'granted'
}

async function queryPermission(handle: SaveDirectoryHandle): Promise<PermissionState> {
  // 有些实现没有权限查询，那就当它已经授权（老实现是选完即授权的模型）
  if (typeof handle.queryPermission !== 'function') return 'granted'
  try {
    return await handle.queryPermission({ mode: 'readwrite' })
  } catch {
    return 'granted'
  }
}

/**
 * 让用户选一个文件夹。
 *
 * ⚠️ 必须在用户手势（点击）里调用。
 * @returns 文件夹名；用户取消或失败时返回 null
 */
export async function pickSaveFolder(): Promise<string | null> {
  const picker = directoryPicker()
  if (picker === undefined) return null

  try {
    const handle = await picker({ id: 'rhythm-4k-save', mode: 'readwrite' })
    if (!(await ensurePermission(handle))) return null

    folderHandle = handle
    await persistHandle(handle)
    return handle.name
  } catch {
    // 用户点取消时也会抛异常（AbortError），这不算错误，安静返回
    return null
  }
}

/**
 * 重新申请当前文件夹的写入权限。
 *
 * ⚠️ 必须在用户手势里调用 —— 这是 Chrome 的硬性要求。
 */
export async function requestSaveFolderPermission(): Promise<boolean> {
  if (folderHandle === null) return false
  return ensurePermission(folderHandle)
}

async function ensurePermission(handle: SaveDirectoryHandle): Promise<boolean> {
  if ((await queryPermission(handle)) === 'granted') return true
  if (typeof handle.requestPermission !== 'function') return false

  try {
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

/**
 * 从 IndexedDB 里恢复上次选过的文件夹。
 *
 * 只恢复句柄，**不申请权限** —— 申请权限需要用户手势，这里没有。
 * 调用方拿到状态后如果发现 writable 为 false，应该提示用户点一下重新授权。
 */
export async function restoreSaveFolder(): Promise<SaveFolderStatus> {
  const supported = isSaveFolderSupported()
  if (!supported) return { supported: false, name: null, writable: false }

  const handle = await loadHandle()
  if (handle === null) return { supported: true, name: null, writable: false }

  folderHandle = handle
  return { supported: true, name: handle.name, writable: await isSaveFolderWritable() }
}

/** 忘记当前文件夹（不影响磁盘上的文件）。 */
export function forgetSaveFolder(): void {
  folderHandle = null
  void clearHandle()
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

/** 只认谱面包的扩展名 */
function isChartArchiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.osz') || lower.endsWith('.zip')
}

/**
 * 列出文件夹里的谱面包，**新的排前面**。
 *
 * 单个文件读失败（被别的程序占用、刚被删掉）会跳过，不让一条坏记录拖垮整个列表。
 */
export async function listSavedChartFiles(): Promise<SavedChartFile[]> {
  const folder = folderHandle
  if (folder === null) return []

  const result: SavedChartFile[] = []
  try {
    for await (const entry of folder.values()) {
      if (entry.kind !== 'file' || !isChartArchiveName(entry.name)) continue
      try {
        const file = await (entry as SaveFileHandle).getFile()
        result.push({
          name: entry.name,
          size: file.size,
          modifiedAt: file.lastModified,
          handle: entry as SaveFileHandle,
        })
      } catch {
        // 跳过读不到的条目
      }
    }
  } catch {
    // 迭代本身失败（权限被收回等）就返回已经拿到的部分
  }

  result.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return result
}

/**
 * 把一份谱面包写进文件夹。
 *
 * 同名文件会被**覆盖** —— 重新导入同一首歌时这是期望行为，不会攒出一堆重复。
 *
 * @returns 是否写入成功
 */
export async function saveChartFileToFolder(
  name: string,
  data: ArrayBuffer,
): Promise<boolean> {
  const folder = folderHandle
  if (folder === null || name === '') return false

  try {
    const fileHandle = await folder.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
    return true
  } catch {
    // 磁盘满、权限被收回、名字非法…… 统一当写入失败，由界面提示
    return false
  }
}

/** 读取文件夹里的一份谱面包。 */
export async function readSavedChartFile(file: SavedChartFile): Promise<ArrayBuffer | null> {
  try {
    const blob = await file.handle.getFile()
    return await blob.arrayBuffer()
  } catch {
    return null
  }
}

/** 从文件夹里删掉一份谱面包。 */
export async function deleteSavedChartFile(file: SavedChartFile): Promise<boolean> {
  const folder = folderHandle
  if (folder === null) return false

  try {
    await folder.removeEntry(file.name)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 句柄的持久化（唯一还用到 IndexedDB 的地方）
// ---------------------------------------------------------------------------

/** 单独一个库，免得和谱面缓存的库撞版本号 */
const HANDLE_DB_NAME = 'rhythm-4k-fs'
const HANDLE_DB_VERSION = 1
const HANDLE_STORE = 'handles'
const HANDLE_KEY = 'saveFolder'

function openHandleDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'))
    request.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'))
  })
}

/** 存句柄。失败只是下次要重新选文件夹，不影响本次使用，所以吞掉异常。 */
async function persistHandle(handle: SaveDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleDatabase()
    const transaction = db.transaction(HANDLE_STORE, 'readwrite')
    transaction.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY)

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // 忽略
  }
}

async function loadHandle(): Promise<SaveDirectoryHandle | null> {
  try {
    const db = await openHandleDatabase()
    const transaction = db.transaction(HANDLE_STORE, 'readonly')
    const request = transaction.objectStore(HANDLE_STORE).get(HANDLE_KEY)

    const value = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()

    return isDirectoryHandle(value) ? value : null
  } catch {
    return null
  }
}

async function clearHandle(): Promise<void> {
  try {
    const db = await openHandleDatabase()
    const transaction = db.transaction(HANDLE_STORE, 'readwrite')
    transaction.objectStore(HANDLE_STORE).delete(HANDLE_KEY)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // 忽略
  }
}

/**
 * 校验从 IndexedDB 读回来的东西确实是个目录句柄。
 *
 * 用户可能清过数据、或者浏览器升级后换了内部结构，
 * 拿到一个形状不对的东西就去调 values() 会直接崩。
 */
function isDirectoryHandle(value: unknown): value is SaveDirectoryHandle {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SaveDirectoryHandle>
  return candidate.kind === 'directory' && typeof candidate.values === 'function'
}
