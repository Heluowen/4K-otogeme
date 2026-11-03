import { decodeAudio } from '../audio/decode'
import { KeySound } from '../audio/key-sound'
import { SongClock } from '../core/clock'
import { Engine, FALL_TIME_MAX, FALL_TIME_MIN, type EngineMetrics } from '../core/engine'
import { formatKeyCode } from '../core/input'
import {
  DEFAULT_NOTE_SIZE_LEVEL,
  depthScale,
  MAX_NOTE_SIZE_LEVEL,
  MAX_TILT_DEGREES,
  MIN_NOTE_SIZE_LEVEL,
  tiltStrengthFromDegrees,
  type NoteShape,
} from '../core/fall-style'
import { GRADE_COLORS, GRADE_LABELS, type JudgeStats } from '../core/judge'
import {
  imageMimeTypeOf,
  pickAudioBytes,
  pickBackgroundBytes,
  readOsuSet,
  toChart,
  type OsuDifficulty,
  type OsuSet,
} from '../osu/loader'
import { bpmAt, type BpmSegment } from '../osu/timing'
import {
  clearCachedSets,
  deleteCachedSet,
  estimateUsage,
  listCachedSets,
  readCachedSet,
  saveCachedSet,
  type CachedChartSetInfo,
} from '../store/chart-cache'
import {
  deleteSavedChartFile,
  getSaveFolderName,
  isSaveFolderSupported,
  isSaveFolderWritable,
  listSavedChartFiles,
  pickSaveFolder,
  readSavedChartFile,
  requestSaveFolderPermission,
  restoreSaveFolder,
  saveChartFileToFolder,
  type SavedChartFile,
} from '../store/save-folder'
import {
  AUDIO_OFFSET_LIMIT,
  bindingsFor,
  COUNTDOWN_MAX,
  COUNTDOWN_MIN,
  defaultBindingsFor,
  loadSettings,
  updateSettings,
  type InfoPanelSide,
  type Settings,
} from '../store/settings'

/**
 * UI 装配层。
 *
 * 负责把「用户操作」翻译成「引擎调用」，把「引擎诊断数据」翻译成「界面文字」，
 * 以及管理三个界面状态之间的切换：导入 → 选难度 → 播放（+ 设置 / 结算叠加层）。
 *
 * 这一层刻意不含任何音游逻辑 —— 时间、位置、速度、判定全都在 core/ 里。
 * 这个应用全局只有一个实例，所以状态直接用模块级变量，不做成类。
 */

// ---------------------------------------------------------------------------
// 元素引用
// ---------------------------------------------------------------------------

/** 取元素，取不到就直接抛错 —— 让拼错 id 这类低级问题在启动瞬间暴露，而不是运行时静默失败 */
function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`index.html 里找不到 #${id}`)
  return element as T
}

const settingsBtn = must<HTMLButtonElement>('settings-btn')
const infoSideSelect = must<HTMLSelectElement>('info-side')

const importPanel = must('import-panel')
const dropzone = must<HTMLDivElement>('dropzone')
const fileInput = must<HTMLInputElement>('file-input')
const importStatus = must<HTMLParagraphElement>('import-status')
const savePanel = must('save-panel')
const saveTitle = must<HTMLElement>('save-title')
const saveStatus = must<HTMLParagraphElement>('save-status')
const saveList = must<HTMLUListElement>('save-list')
const folderPickBtn = must<HTMLButtonElement>('folder-pick')
const folderGrantBtn = must<HTMLButtonElement>('folder-grant')
const saveClearBtn = must<HTMLButtonElement>('save-clear')

const pickPanel = must('pick-panel')
const pickInfo = must<HTMLParagraphElement>('pick-info')
const difficultyList = must<HTMLUListElement>('difficulty-list')
const pickBack = must<HTMLButtonElement>('pick-back')

const playPanel = must('play-panel')
const canvas = must<HTMLCanvasElement>('stage-canvas')
const playBtn = must<HTMLButtonElement>('play-btn')
const restartBtn = must<HTMLButtonElement>('restart-btn')
const playBack = must<HTMLButtonElement>('play-back')
const keyHint = must<HTMLElement>('key-hint')
const tiltBtn = must<HTMLButtonElement>('tilt-btn')
const shapeBtn = must<HTMLButtonElement>('shape-btn')

const playLayout = must<HTMLDivElement>('play-layout')
const infoPanel = must<HTMLElement>('info-panel')
const infoCoverImg = must<HTMLImageElement>('info-cover-img')
const infoCoverEmpty = must<HTMLElement>('info-cover-empty')
const infoTitle = must<HTMLElement>('info-title')
const infoArtist = must<HTMLElement>('info-artist')
const infoCreator = must<HTMLElement>('info-creator')
const infoVersion = must<HTMLElement>('info-version')
const infoBpm = must<HTMLElement>('info-bpm')
const infoNotes = must<HTMLElement>('info-notes')
const hudElement = must<HTMLDListElement>('hud')

const settingsOverlay = must('settings-overlay')
const settingsClose = must<HTMLButtonElement>('settings-close')
const keymapElement = must('keymap')
const keymapStatus = must<HTMLParagraphElement>('keymap-status')
const keymapReset = must<HTMLButtonElement>('keymap-reset')
const fallTimeInput = must<HTMLInputElement>('falltime')
const fallTimeValue = must<HTMLElement>('falltime-value')
const offsetInput = must<HTMLInputElement>('audio-offset')
const offsetValue = must<HTMLElement>('offset-value')
const ignoreSvInput = must<HTMLInputElement>('ignore-sv')
const countdownInput = must<HTMLInputElement>('countdown')
const countdownValue = must<HTMLElement>('countdown-value')
const keySoundInput = must<HTMLInputElement>('key-sound')
const keySoundVolumeInput = must<HTMLInputElement>('key-sound-volume')
const keySoundVolumeValue = must<HTMLElement>('key-sound-volume-value')
const tiltInput = must<HTMLInputElement>('tilt')
const tiltValue = must<HTMLElement>('tilt-value')
const tiltEffective = must<HTMLElement>('tilt-effective')
const noteSizeSelect = must<HTMLSelectElement>('note-size')

const resultOverlay = must('result-overlay')
const resultRank = must<HTMLElement>('result-rank')
const resultScore = must<HTMLElement>('result-score')
const resultAccuracy = must<HTMLElement>('result-accuracy')
const resultMaxCombo = must<HTMLElement>('result-maxcombo')
const resultCounts = must<HTMLUListElement>('result-counts')
const resultFullCombo = must<HTMLElement>('result-fullcombo')
const resultOffset = must<HTMLParagraphElement>('result-offset')
const resultRetry = must<HTMLButtonElement>('result-retry')
const resultFixOffset = must<HTMLButtonElement>('result-fix-offset')
const resultBack = must<HTMLButtonElement>('result-back')

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

/** 当前正在播放的引擎 */
let engine: Engine | null = null

/**
 * 全局复用一个 AudioContext。
 * 浏览器对同时存在的 AudioContext 数量有限制（约 6 个），
 * 每首歌都新建一个的话，切几次歌就会失败。
 */
let audioContext: AudioContext | null = null

/**
 * 按键音。和 AudioContext 一起在首个用户手势时创建，全局复用一个实例 ——
 * 这样每条轨道的音色 buffer 只生成一次，而且设置面板在没有引擎的时候也能试听。
 */
let keySound: KeySound | null = null

/** 当前难度的 BPM 分段，仅用于 HUD 显示 */
let currentBpmSegments: BpmSegment[] | null = null

/** 全部设置，启动时从 localStorage 读一次，改动立刻写回 */
let settings: Settings = loadSettings()

/** 当前谱面的键数（按键映射区要按这个数字生成） */
let currentKeyCount = 4

/** 当前生效的按键映射，长度等于 currentKeyCount */
let currentBindings: string[] = []

/** 正在等待用户按键的轨道号；-1 表示当前不在捕获状态 */
let capturingLane = -1

/** 最近一局的结算数据，「用平均偏差修正」按钮要用 */
let lastStats: JudgeStats | null = null

/**
 * 当前曲绘的 object URL。
 * 换歌或离开游玩界面时必须 revoke —— object URL 会一直把整张图钉在内存里，
 * 不释放的话切几首歌就会攒下几十 MB。
 */
let currentCoverUrl: string | null = null

/** 修饰键单独按下不适合当轨道键：Alt 会抢走焦点，CapsLock 有系统状态 */
const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'ContextMenu',
])

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 启动应用。由 main.ts 调用。 */
export function startApp(): void {
  buildHud()
  bindImport()
  bindPlayPanel()
  bindSettings()
  bindResult()
  applySettingsToUi()
  refreshBindings(4)
  showPanel('import')
  // 恢复上次选过的存档文件夹。这一步只恢复句柄、不申请权限 ——
  // 申请权限需要用户手势，会在界面上提示用户点「重新授权」。
  void restoreSaveFolder().then(() => refreshSavedList())

  // 曲绘解码失败（文件损坏、格式不支持）时退回占位文案，而不是留一个破图
  infoCoverImg.addEventListener('error', () => {
    infoCoverImg.hidden = true
    infoCoverEmpty.hidden = false
  })
}

// ---------------------------------------------------------------------------
// ① 导入
// ---------------------------------------------------------------------------

function bindImport(): void {
  const openPicker = (): void => fileInput.click()

  dropzone.addEventListener('click', openPicker)
  // 让拖放区可以用键盘操作（回车 / 空格）
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openPicker()
    }
  })

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) void importFile(file)
    // 清空 value，否则连续选同一个文件不会触发 change
    fileInput.value = ''
  })

  dropzone.addEventListener('dragover', (event) => {
    // 必须阻止默认行为，否则浏览器会直接"打开"这个文件，页面就被导航走了
    event.preventDefault()
    dropzone.classList.add('is-over')
  })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'))
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault()
    dropzone.classList.remove('is-over')
    const file = event.dataTransfer?.files?.[0]
    if (file) void importFile(file)
  })

  // 在整个窗口上兜底：防止用户把文件拖到拖放区外面时浏览器直接打开它
  window.addEventListener('dragover', (event) => event.preventDefault())
  window.addEventListener('drop', (event) => event.preventDefault())

  // 存档文件夹的三个按钮
  folderPickBtn.addEventListener('click', () => {
    // showDirectoryPicker 必须在用户手势里调用，这里正好在 click 回调链上
    void (async () => {
      const name = await pickSaveFolder()
      if (name === null) {
        setStatus(importStatus, '没有选择文件夹。')
        return
      }
      setStatus(importStatus, `存档文件夹已设为「${name}」，之后导入的谱面会直接存进这里。`)
      await refreshSavedList()
    })()
  })

  folderGrantBtn.addEventListener('click', () => {
    // requestPermission 同样必须在用户手势里
    void (async () => {
      const granted = await requestSaveFolderPermission()
      if (!granted) setStatus(importStatus, '没有拿到文件夹的读写权限。', true)
      await refreshSavedList()
    })()
  })

  saveClearBtn.addEventListener('click', () => {
    void clearCachedSets().then(refreshSavedList)
  })
}

/** 读取一个 .osz / .zip 并列出里面的 mania 难度。 */
async function importFile(file: File): Promise<void> {
  setStatus(importStatus, `正在解压「${file.name}」…`)
  showPanel('import')

  let buffer: ArrayBuffer
  try {
    buffer = await file.arrayBuffer()
  } catch (error) {
    setStatus(importStatus, `读取文件失败：${describeError(error)}`, true)
    return
  }

  const opened = await loadSetFromBuffer(file.name, buffer)
  if (opened) {
    // 解析成功了才存档 —— 存一个读不出来的包没有意义。
    // 刻意不 await：存档是后台的事，不该让用户等它。
    void saveIncomingChart(file.name, buffer)
  }
}

/**
 * 解包 → 解析 → 切到难度列表。
 *
 * 不管数据是拖进来的文件还是从索引缓存里读出来的，走的都是这一条路径，
 * 避免两条加载路径慢慢跑偏。
 */
async function loadSetFromBuffer(sourceName: string, buffer: ArrayBuffer): Promise<boolean> {
  try {
    const set = await readOsuSet(sourceName, buffer)
    renderDifficultyList(set)
    showPanel('pick')
    return true
  } catch (error) {
    setStatus(importStatus, `导入失败：${describeError(error)}`, true)
    showPanel('import')
    return false
  }
}

// ---------------------------------------------------------------------------
// ④ 谱面存档
// ---------------------------------------------------------------------------
//
// 优先用「存档文件夹」：导入的 .osz 直接写进用户选定的磁盘文件夹，不占浏览器存储。
// 浏览器不支持 File System Access API（Firefox / Safari）时，退回 IndexedDB 存储 ——
// 功能降级，而不是直接不给用。

/** 浏览器支不支持目录授权。不支持就退回浏览器存储。 */
const SAVE_FOLDER_SUPPORTED = isSaveFolderSupported()

/**
 * 把刚导入的谱面包存下来。
 *
 * 文件夹优先；写不进去（没授权、磁盘满）就退回浏览器存储 ——
 * 宁可多占一点空间，也别让用户白导入一次。
 */
async function saveIncomingChart(name: string, buffer: ArrayBuffer): Promise<void> {
  if (!SAVE_FOLDER_SUPPORTED) {
    await cacheInBrowser(name, buffer)
    return
  }

  if (await saveChartFileToFolder(name, buffer)) {
    await refreshSavedList()
    return
  }

  setStatus(
    importStatus,
    '写入存档文件夹失败（可能没有授权，或者磁盘已满），已改为存进浏览器存储。',
    true,
  )
  await cacheInBrowser(name, buffer)
}

/** 浏览器存储这条退路。失败完全静默 —— 它只是兜底，不该打扰用户。 */
async function cacheInBrowser(name: string, buffer: ArrayBuffer): Promise<void> {
  try {
    const saved = await saveCachedSet(name, buffer)
    if (saved) await refreshSavedList()
  } catch {
    // 存不进去就算了（隐私模式、配额满），不影响已经完成的导入
  }
}

/** 从存档文件夹里打开一个谱面。 */
async function openSavedFile(file: SavedChartFile): Promise<void> {
  setStatus(importStatus, `正在从存档文件夹读取「${file.name}」…`)
  showPanel('import')

  const buffer = await readSavedChartFile(file)
  if (buffer === null) {
    setStatus(importStatus, `读取「${file.name}」失败，文件可能已经被移动或删除。`, true)
    await refreshSavedList()
    return
  }

  // 从文件夹打开的谱面本来就在文件夹里，不需要再存一次
  await loadSetFromBuffer(file.name, buffer)
}

/** 从浏览器存储里打开一个谱面（退路）。 */
async function openCachedSet(name: string): Promise<void> {
  setStatus(importStatus, `正在从浏览器存储读取「${name}」…`)
  showPanel('import')

  const cached = await readCachedSet(name)
  if (cached === null) {
    setStatus(importStatus, `浏览器存储里找不到「${name}」，可能已经被清理了。`, true)
    await refreshSavedList()
    return
  }

  const opened = await loadSetFromBuffer(cached.name, cached.data)
  if (!opened) {
    // 存的内容坏了 —— 直接删掉，免得用户反复点到同一个坏条目
    await deleteCachedSet(name)
    await refreshSavedList()
  }
}

/** 重新渲染存档列表。 */
async function refreshSavedList(): Promise<void> {
  if (!SAVE_FOLDER_SUPPORTED) {
    await refreshBrowserList()
    return
  }

  saveTitle.textContent = '存档文件夹'
  saveClearBtn.hidden = true
  saveList.replaceChildren()
  savePanel.hidden = false

  const folderName = getSaveFolderName()

  // ① 还没选过文件夹
  if (folderName === null) {
    folderPickBtn.textContent = '选择文件夹'
    folderGrantBtn.hidden = true
    setStatus(
      saveStatus,
      '还没有选择存档文件夹。选一次之后，导入的谱面会直接写进那个文件夹，不再占用浏览器存储。',
    )
    return
  }

  folderPickBtn.textContent = '更换文件夹'

  // ② 句柄还在，但写入权限需要用户再点一下确认
  //    （Chrome 出于安全考虑，每次重新打开页面都会要求重新确认）
  const writable = await isSaveFolderWritable()
  folderGrantBtn.hidden = writable
  if (!writable) {
    setStatus(
      saveStatus,
      `存档文件夹「${folderName}」需要重新授权才能读写。` +
        'Chrome 出于安全考虑，每次重新打开页面都会要求再确认一次。',
    )
    return
  }

  // ③ 正常状态：列出文件夹里的谱面
  const files = await listSavedChartFiles()
  if (files.length === 0) {
    setStatus(
      saveStatus,
      `存档文件夹「${folderName}」里还没有谱面。拖入 .osz 导入的谱面会自动存进这里。`,
    )
    return
  }

  for (const file of files) saveList.append(buildSavedFileItem(file))
  setStatus(saveStatus, `存档文件夹「${folderName}」· 共 ${files.length} 个谱面`)
}

/** 浏览器存储这条退路的列表。 */
async function refreshBrowserList(): Promise<void> {
  const list = await listCachedSets()

  saveTitle.textContent = '最近导入（浏览器存储）'
  saveClearBtn.hidden = list.length === 0
  folderPickBtn.hidden = true
  folderGrantBtn.hidden = true
  saveList.replaceChildren()
  savePanel.hidden = false

  if (list.length === 0) {
    setStatus(
      saveStatus,
      '当前浏览器不支持选择文件夹（需要用 Chrome / Edge），谱面只能存进浏览器存储。',
    )
    return
  }

  for (const info of list) saveList.append(buildCachedSetItem(info))

  const cachedBytes = list.reduce((sum, item) => sum + item.size, 0)
  const usage = await estimateUsage()
  setStatus(
    saveStatus,
    `当前浏览器不支持选择文件夹（需要用 Chrome / Edge），谱面存在浏览器里。` +
      `已用 ${formatBytes(cachedBytes)}` +
      (usage !== null && usage.quota > 0
        ? `，浏览器总用量 ${formatBytes(usage.usage)} / 配额 ${formatBytes(usage.quota)}。`
        : '。'),
  )
}

/** 存档文件夹里的一项。 */
function buildSavedFileItem(file: SavedChartFile): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'recent-item'

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'recent-open'
  open.addEventListener('click', () => {
    open.blur()
    void openSavedFile(file)
  })

  const name = document.createElement('span')
  name.className = 'recent-name'
  name.textContent = file.name

  const meta = document.createElement('span')
  meta.className = 'recent-meta'
  meta.textContent = `${formatBytes(file.size)} · ${formatDate(file.modifiedAt)}`

  open.append(name, meta)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'recent-remove'
  remove.title = '从文件夹里删除'
  remove.setAttribute('aria-label', `从文件夹里删除 ${file.name}`)
  remove.textContent = '×'
  remove.addEventListener('click', () => {
    void deleteSavedChartFile(file).then(refreshSavedList)
  })

  item.append(open, remove)
  return item
}

/** 浏览器存储里的一项。 */
function buildCachedSetItem(info: CachedChartSetInfo): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'recent-item'

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'recent-open'
  open.addEventListener('click', () => {
    open.blur()
    void openCachedSet(info.name)
  })

  const name = document.createElement('span')
  name.className = 'recent-name'
  name.textContent = info.name

  const meta = document.createElement('span')
  meta.className = 'recent-meta'
  meta.textContent = `${formatBytes(info.size)} · ${formatDate(info.savedAt)}`

  open.append(name, meta)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'recent-remove'
  remove.title = '从浏览器存储里删除'
  remove.setAttribute('aria-label', `从浏览器存储里删除 ${info.name}`)
  remove.textContent = '×'
  remove.addEventListener('click', () => {
    void deleteCachedSet(info.name).then(refreshSavedList)
  })

  item.append(open, remove)
  return item
}

// ---------------------------------------------------------------------------
// ② 难度选择
// ---------------------------------------------------------------------------

function renderDifficultyList(set: OsuSet): void {
  difficultyList.replaceChildren()

  // 同一首歌的所有难度共享元信息，取第一个就行
  const first = set.difficulties[0].beatmap
  const songName =
    [first.artist, first.title].filter((part) => part !== '').join(' - ') || '（无标题）'
  pickInfo.textContent = `${songName} · ${first.creator || '未知谱师'} · 共 ${set.difficulties.length} 个 mania 难度`

  for (const difficulty of set.difficulties) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'diff-item'
    button.addEventListener('click', () => {
      // 点掉焦点，避免它一直持有焦点导致空格键触发按钮而不是播放/暂停
      button.blur()
      void startDifficulty(set, difficulty)
    })

    const name = document.createElement('span')
    name.className = 'diff-name'
    name.textContent = difficulty.name

    // 键数徽标。4K 加粗强调，其它键数标黄提醒（引擎本身支持任意键数，
    // 但按键映射的默认值和整体调校是围绕 4K 做的）
    const keys = document.createElement('span')
    keys.className = difficulty.keyCount === 4 ? 'diff-keys' : 'diff-keys is-other'
    keys.textContent = `${difficulty.keyCount}K`

    const meta = document.createElement('span')
    meta.className = 'diff-meta'
    meta.textContent = `${difficulty.noteCount} 音符`

    button.append(name, meta, keys)
    item.append(button)
    difficultyList.append(item)
  }
}

// ---------------------------------------------------------------------------
// 音频设备
// ---------------------------------------------------------------------------

interface AudioRig {
  context: AudioContext
  keySound: KeySound
}

/**
 * 确保 AudioContext 和按键音就绪，整个页面只建一次。
 *
 * 浏览器要求 AudioContext 必须由**用户手势**创建/唤醒，所以这个函数只会从
 * 点击/拖放这类回调里调用。
 *
 * 之所以要单独拎出来（而不是像最初那样写在"开始播放"里），是为了让设置面板里的
 * 按键音试听在没有引擎、还没打过任何谱面时也能出声。
 */
function ensureAudio(): AudioRig {
  let context = audioContext
  if (context === null) {
    context = new AudioContext({ latencyHint: 'interactive' })
    audioContext = context
  }

  let sound = keySound
  if (sound === null) {
    sound = new KeySound(context)
    // 新建出来时就把当前设置应用上，否则首次试听会用默认音量
    sound.setEnabled(settings.keySoundEnabled)
    sound.setVolume(settings.keySoundVolume / 100)
    keySound = sound
  }

  if (context.state === 'suspended') {
    void context.resume()
  }

  return { context, keySound: sound }
}

/**
 * 试听按键音。
 *
 * 一次性把所有轨道都响一遍 —— 它们是五声音阶，一起响就是一个和弦，
 * 比只响一个音更能让用户听出各轨音高的区别。
 *
 * 这里会调用 ensureAudio()，而它本身就是从 change 事件（用户手势）里被调用的，
 * 所以即使还没打过任何谱面，试听也能正常出声。
 */
function previewKeySound(): void {
  if (!settings.keySoundEnabled) return

  let rig: AudioRig
  try {
    rig = ensureAudio()
  } catch {
    // 建不出 AudioContext（少见）就当没听见，不打扰用户
    return
  }

  for (let lane = 0; lane < currentKeyCount; lane++) {
    rig.keySound.play(lane)
  }
}

// ---------------------------------------------------------------------------
// ④ 信息栏
// ---------------------------------------------------------------------------

/** 信息缺失时统一显示的文案 */
const NO_INFO = '暂无消息'

/** 信息栏的口径：没有就给一句「暂无消息」，而不是留一块空白 */
function orNoInfo(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return NO_INFO
  const text = String(value).trim()
  return text === '' ? NO_INFO : text
}

/**
 * 把 BPM 分段整理成一行。
 * 变速谱面显示成范围（比如 "120 - 240"），单速就显示一个数。
 */
function formatBpm(segments: readonly BpmSegment[]): string {
  if (segments.length === 0) return ''

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const segment of segments) {
    if (segment.bpm < min) min = segment.bpm
    if (segment.bpm > max) max = segment.bpm
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) return ''

  // 最多两位小数，并去掉多余的 0（180 而不是 180.00）
  const round = (value: number): string => String(Math.round(value * 100) / 100)
  return min === max ? round(min) : `${round(min)} - ${round(max)}`
}

/**
 * 用压缩包里的图片字节做一张曲绘。
 *
 * 用 Blob + object URL 而不是 data URL：曲绘动辄好几 MB，
 * 转成 base64 会膨胀三分之一，而且会一直躺在 DOM 属性里。
 */
function createCoverUrl(bytes: Uint8Array<ArrayBuffer>, fileName: string): string | null {
  const mime = imageMimeTypeOf(fileName)
  // MIME 给不对的话 <img> 会直接拒绝加载，所以认不出扩展名就当没有曲绘
  if (mime === null) return null

  try {
    return URL.createObjectURL(new Blob([bytes], { type: mime }))
  } catch {
    return null
  }
}

function revokeCoverUrl(): void {
  if (currentCoverUrl === null) return
  URL.revokeObjectURL(currentCoverUrl)
  currentCoverUrl = null
}

/** 切换曲绘。传 null 表示这张谱面没有曲绘。 */
function setCover(url: string | null): void {
  // 先释放上一张，再换新的
  revokeCoverUrl()

  if (url === null) {
    infoCoverImg.hidden = true
    infoCoverImg.removeAttribute('src')
    infoCoverEmpty.hidden = false
    return
  }

  currentCoverUrl = url
  infoCoverEmpty.hidden = true
  infoCoverImg.hidden = false
  infoCoverImg.src = url
}

/** 把这一局的歌曲信息填进信息栏。 */
function renderInfoPanel(
  difficulty: OsuDifficulty,
  noteCount: number,
  coverUrl: string | null,
): void {
  const { beatmap } = difficulty

  setCover(coverUrl)

  infoTitle.textContent = orNoInfo(beatmap.title)
  infoArtist.textContent = orNoInfo(beatmap.artist)
  infoCreator.textContent = orNoInfo(beatmap.creator)
  infoVersion.textContent = orNoInfo(difficulty.name)
  infoBpm.textContent = orNoInfo(formatBpm(difficulty.bpmSegments))
  // 0 个音符等于没有谱面内容，按"信息缺失"处理
  infoNotes.textContent = orNoInfo(noteCount || '')
}

/** 把「信息栏位置」这个设置应用到界面上。 */
function applyInfoPanel(): void {
  const side = settings.infoPanelSide
  // 方向由 CSS 的 flex-direction 切换，不需要在 JS 里挪 DOM
  playLayout.dataset.side = side === 'left' ? 'left' : 'right'
  infoPanel.hidden = side === 'off'
  syncLayoutClasses()
}

/**
 * 同步挂在 body 上的布局类。
 *
 * CSS 靠这两个类决定外层容器要放宽到多少（见 style.css）：
 * 游玩时放宽一次，信息栏占位时再放宽一次 —— 不加宽的话信息栏会直接
 * 吃掉轨道的宽度，把游玩区挤小，和"把游玩区做大"的初衷正好相反。
 */
function syncLayoutClasses(): void {
  const playing = !playPanel.hidden
  const hasInfoPanel = playing && settings.infoPanelSide !== 'off'
  document.body.classList.toggle('is-playing', playing)
  document.body.classList.toggle('has-info-panel', hasInfoPanel)
}

// ---------------------------------------------------------------------------
// ⑤ 下落样式（倾斜轨道 / 音符形状）
// ---------------------------------------------------------------------------

/**
 * 倾斜按钮：在 0° 和上限之间来回切。
 *
 * 想要别的角度用设置面板里的滑条。这两者共用同一个设置项
 * （`settings.tiltDegrees`），所以不会出现"按钮说是开的、滑条说是 0"这种矛盾状态。
 */
function toggleTilt(): void {
  applyTiltDegrees(settings.tiltDegrees > 0 ? 0 : MAX_TILT_DEGREES)
}

function applyTiltDegrees(degrees: number): void {
  const next = Math.max(0, Math.min(MAX_TILT_DEGREES, Math.round(degrees)))
  settings = updateSettings({ tiltDegrees: next })
  engine?.setTiltDegrees(next)
  syncTiltControls()
}

/** 把倾斜设置同步到滑条和按钮上。 */
function syncTiltControls(): void {
  tiltInput.value = String(settings.tiltDegrees)
  tiltValue.textContent = String(settings.tiltDegrees)
  // aria-pressed 同时承担无障碍语义和 CSS 高亮，两者共用一个来源
  tiltBtn.setAttribute('aria-pressed', settings.tiltDegrees > 0 ? 'true' : 'false')

  // 顺带告诉用户这个角度对应多强的透视：轨道最远处会缩到判定线宽度的百分之多少。
  // 光看"40°"其实看不出效果强弱，这个百分比直观得多。
  const farScale = depthScale(tiltStrengthFromDegrees(settings.tiltDegrees), 1)
  tiltEffective.textContent =
    settings.tiltDegrees > 0 ? `（远端宽度 ${Math.round(farScale * 100)}%）` : ''
}

/** 形状按钮：方形 ↔ 圆形。 */
function toggleShape(): void {
  const next: NoteShape = settings.noteShape === 'circle' ? 'square' : 'circle'
  settings = updateSettings({ noteShape: next })
  engine?.setNoteShape(next)
  syncShapeControls()
}

function syncShapeControls(): void {
  shapeBtn.setAttribute('aria-pressed', settings.noteShape === 'circle' ? 'true' : 'false')
}

/**
 * 音符大小档位（1–5）。
 *
 * 非法输入回到基准档而不是夹到边界 —— 夹到 1（最小）会让用户莫名其妙地
 * 发现音符突然变得极小，那比"回到默认"更难理解。
 */
function applyNoteSizeLevel(level: number): void {
  const rounded = Number.isFinite(level) ? Math.round(level) : DEFAULT_NOTE_SIZE_LEVEL
  const next = Math.min(MAX_NOTE_SIZE_LEVEL, Math.max(MIN_NOTE_SIZE_LEVEL, rounded))

  settings = updateSettings({ noteSizeLevel: next })
  engine?.setNoteSizeLevel(next)
  // 读回来，保证下拉框显示的和真正生效的一致
  noteSizeSelect.value = String(next)
}

// ---------------------------------------------------------------------------
// ③ 开始播放
// ---------------------------------------------------------------------------

async function startDifficulty(set: OsuSet, difficulty: OsuDifficulty): Promise<void> {
  setStatus(pickInfo, `正在解码音频「${difficulty.beatmap.audioFilename || '未指定'}」…`)

  let audioBytes = pickAudioBytes(set, difficulty)
  if (audioBytes === null) {
    // 压缩包里找不到音频（AudioFilename 写错、或谱面把音频放在外面）。
    // 与其直接失败，不如让用户手动指一个。
    setStatus(pickInfo, '压缩包里找不到音频文件，请手动选择这首歌的音频。')
    audioBytes = await pickAudioFileManually()
    if (audioBytes === null) {
      setStatus(pickInfo, '已取消。')
      return
    }
  }

  // AudioContext 必须在用户手势里创建/唤醒，否则会是 suspended 状态（无声）。
  // 这里处于按钮点击的回调链上，所以是合法的手势上下文。
  const audio = ensureAudio()

  let audioBuffer: AudioBuffer
  try {
    audioBuffer = await decodeAudio(audio.context, audioBytes)
  } catch (error) {
    setStatus(
      pickInfo,
      `音频解码失败：${describeError(error)}\n该格式可能不被浏览器支持（例如 flac），换一首试试。`,
      true,
    )
    return
  }

  // 先销毁旧引擎：它会停掉音频源、断开键盘监听和 ResizeObserver
  engine?.destroy()
  engine = null

  const chart = toChart(difficulty)
  currentBpmSegments = difficulty.bpmSegments
  lastStats = null

  // 曲绘：从压缩包里取出图片字节再做成 object URL。
  // 压缩包里没有、或者谱面没声明，都会拿到 null，信息栏显示"暂无消息"。
  const backgroundBytes = pickBackgroundBytes(set, difficulty)
  const coverUrl =
    backgroundBytes === null
      ? null
      : createCoverUrl(backgroundBytes, difficulty.beatmap.backgroundFilename)

  renderInfoPanel(difficulty, chart.notes.length, coverUrl)

  // 先切到播放面板，再创建引擎 —— 引擎构造时要量画布尺寸，
  // 面板还是 display:none 的话量出来是 0。
  resultOverlay.hidden = true
  settingsOverlay.hidden = true
  showPanel('play')

  // 按这张谱面的键数准备好按键映射，并刷新设置面板里的映射区
  refreshBindings(chart.keyCount)

  engine = new Engine({
    canvas,
    chart,
    clock: new SongClock(audio.context, audioBuffer),
    keySound: audio.keySound,
    fallTimeMs: settings.fallTimeMs,
    ignoreChartSv: settings.ignoreChartSv,
    countdownMs: settings.countdownMs,
    tiltDegrees: settings.tiltDegrees,
    noteShape: settings.noteShape,
    noteSizeLevel: settings.noteSizeLevel,
    onMetrics: renderHud,
    onFinished: showResult,
  })
  engine.setKeyBindings(currentBindings)
  engine.setAudioOffset(settings.audioOffsetMs)
  engine.mount()

  // 立刻开始播放（首次播放时 clock 里会有一段提前量，用于让调度更稳）
  await engine.restart()
}

/** 弹出系统文件选择框，让用户手动指定音频文件。 */
function pickAudioFileManually(): Promise<Uint8Array<ArrayBuffer> | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*'

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      void file.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)))
    })
    // 用户直接关掉选择框时不会触发 change，靠 cancel 事件兜底
    input.addEventListener('cancel', () => resolve(null))

    input.click()
  })
}

// ---------------------------------------------------------------------------
// 播放控件
// ---------------------------------------------------------------------------

function bindPlayPanel(): void {
  playBtn.addEventListener('click', () => {
    playBtn.blur()
    void engine?.togglePlay()
  })

  restartBtn.addEventListener('click', () => {
    restartBtn.blur()
    resultOverlay.hidden = true
    void engine?.restart()
  })

  playBack.addEventListener('click', backToImport)
  pickBack.addEventListener('click', () => showPanel('import'))

  // 两个下落样式切换按钮
  tiltBtn.addEventListener('click', () => {
    tiltBtn.blur()
    toggleTilt()
  })
  shapeBtn.addEventListener('click', () => {
    shapeBtn.blur()
    toggleShape()
  })

  // 空格键播放/暂停。
  // 有几个前提：焦点不在任何控件上、设置/结算面板没开着、
  // 并且空格没有被用户绑成轨道键 —— 最后一条很重要，
  // 否则 5K 及以上键数的玩家会发现空格既打音符又切暂停。
  window.addEventListener('keydown', (event) => {
    if (playPanel.hidden) return
    if (event.code !== 'Space' || event.target !== document.body) return
    if (currentBindings.includes('Space')) return
    if (!settingsOverlay.hidden || !resultOverlay.hidden) return
    event.preventDefault()
    void engine?.togglePlay()
  })
}

/** 回到导入界面，并销毁引擎。 */
function backToImport(): void {
  engine?.destroy()
  engine = null
  currentBpmSegments = null
  lastStats = null
  // 曲绘的 object URL 不释放的话，切几首歌就会攒下几十 MB
  revokeCoverUrl()
  resultOverlay.hidden = true
  settingsOverlay.hidden = true
  showPanel('import')
}

// ---------------------------------------------------------------------------
// 设置面板（含按键映射）
// ---------------------------------------------------------------------------

function bindSettings(): void {
  settingsBtn.addEventListener('click', openSettings)
  settingsClose.addEventListener('click', closeSettings)

  // 点遮罩空白处关闭
  settingsOverlay.addEventListener('click', (event) => {
    if (event.target === settingsOverlay) closeSettings()
  })

  // Esc 关闭设置（捕获状态下的 Esc 由 captureKeyDown 自己处理）
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (settingsOverlay.hidden) return
    if (capturingLane >= 0) return
    closeSettings()
  })

  // ★ 按键捕获：挂在**捕获阶段**，这样它会比 InputManager 的冒泡监听先执行，
  //   再用 stopPropagation 直接掐断，游戏侧完全收不到这次按键。
  window.addEventListener('keydown', captureKeyDown, true)

  // 下落时间
  fallTimeInput.addEventListener('input', () => {
    const ms = Number(fallTimeInput.value)
    fallTimeValue.textContent = String(ms)
    settings = updateSettings({ fallTimeMs: ms })
    engine?.setFallTime(ms)
  })

  // 音频偏移
  offsetInput.addEventListener('input', () => {
    const ms = Number(offsetInput.value)
    offsetValue.textContent = formatOffset(ms)
    settings = updateSettings({ audioOffsetMs: ms })
    engine?.setAudioOffset(ms)
  })

  // 信息栏位置
  infoSideSelect.addEventListener('change', () => {
    const raw = infoSideSelect.value
    const side: InfoPanelSide = raw === 'left' ? 'left' : raw === 'off' ? 'off' : 'right'
    settings = updateSettings({ infoPanelSide: side })
    applyInfoPanel()
  })

  // 下落样式：倾斜角度滑条
  tiltInput.addEventListener('input', () => {
    applyTiltDegrees(Number(tiltInput.value))
  })

  // 下落样式：音符大小档位
  noteSizeSelect.addEventListener('change', () => {
    applyNoteSizeLevel(Number(noteSizeSelect.value))
  })

  // 是否忽略谱面 SV
  ignoreSvInput.addEventListener('change', () => {
    settings = updateSettings({ ignoreChartSv: ignoreSvInput.checked })
    engine?.setIgnoreChartSv(ignoreSvInput.checked)
  })

  // 准备倒计时（界面是秒，内部一律毫秒）
  countdownInput.addEventListener('input', () => {
    const ms = Math.round(Number(countdownInput.value) * 1000)
    countdownValue.textContent = formatSeconds(ms)
    settings = updateSettings({ countdownMs: ms })
    // 下一次"从头发起播放"时生效；中途恢复播放不会重复倒计时
    engine?.setCountdownMs(ms)
  })

  // 按键音开关
  keySoundInput.addEventListener('change', () => {
    const enabled = keySoundInput.checked
    settings = updateSettings({ keySoundEnabled: enabled })
    keySound?.setEnabled(enabled)
    // 打开的时候立刻试听一下，否则用户不知道到底生效没有
    if (enabled) previewKeySound()
  })

  // 音量数字要跟着拖动实时更新，但声音不能 —— 见下面 change 的注释
  keySoundVolumeInput.addEventListener('input', () => {
    keySoundVolumeValue.textContent = keySoundVolumeInput.value
  })
  // 音量用 change 而不是 input：input 会在拖动过程中连续触发几十次，
  // 那样会瞬间糊出一串音，像卡带一样。
  keySoundVolumeInput.addEventListener('change', () => {
    const volume = Number(keySoundVolumeInput.value)
    settings = updateSettings({ keySoundVolume: volume })
    keySound?.setVolume(volume / 100)
    previewKeySound()
  })

  keymapReset.addEventListener('click', () => {
    currentBindings = defaultBindingsFor(currentKeyCount)
    settings = updateSettings({ keyBindings: [...currentBindings] })
    engine?.setKeyBindings(currentBindings)
    renderKeyHint()
    endCapture('已恢复默认键位。')
  })
}

function openSettings(): void {
  // 打开设置时把游戏暂停下来，避免"一边打一边调"
  if (engine !== null && engine.clock.isPlaying) {
    void engine.togglePlay()
  }
  resultOverlay.hidden = true
  settingsOverlay.hidden = false
}

function closeSettings(): void {
  if (capturingLane >= 0) endCapture('')
  settingsOverlay.hidden = true
}

/** 把设置里的值同步到控件上。 */
function applySettingsToUi(): void {
  // 控件的范围直接取自常量，避免 HTML 里写死一份、代码里又写死一份而慢慢跑偏
  fallTimeInput.min = String(FALL_TIME_MIN)
  fallTimeInput.max = String(FALL_TIME_MAX)
  offsetInput.min = String(-AUDIO_OFFSET_LIMIT)
  offsetInput.max = String(AUDIO_OFFSET_LIMIT)
  // 倒计时在界面上用「秒」，设置里一律存毫秒
  countdownInput.min = String(COUNTDOWN_MIN / 1000)
  countdownInput.max = String(COUNTDOWN_MAX / 1000)

  fallTimeInput.value = String(settings.fallTimeMs)
  fallTimeValue.textContent = String(settings.fallTimeMs)
  offsetInput.value = String(settings.audioOffsetMs)
  offsetValue.textContent = formatOffset(settings.audioOffsetMs)
  ignoreSvInput.checked = settings.ignoreChartSv
  countdownInput.value = String(settings.countdownMs / 1000)
  countdownValue.textContent = formatSeconds(settings.countdownMs)
  keySoundInput.checked = settings.keySoundEnabled
  keySoundVolumeInput.value = String(settings.keySoundVolume)
  keySoundVolumeValue.textContent = String(settings.keySoundVolume)

  // 倾斜滑条的范围直接取自常量，和引擎里的上限保持一致
  tiltInput.min = '0'
  tiltInput.max = String(MAX_TILT_DEGREES)
  syncTiltControls()
  syncShapeControls()
  noteSizeSelect.value = String(settings.noteSizeLevel)

  infoSideSelect.value = settings.infoPanelSide
  applyInfoPanel()
}

/** 把毫秒写成秒。整数不带小数点（3 秒而不是 3.0 秒）。 */
function formatSeconds(ms: number): string {
  const seconds = ms / 1000
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)
}

/**
 * 按谱面的键数准备按键映射，并刷新界面。
 *
 * 映射本身从 settings 里取（可能比当前键数短，缺的用默认键补齐）。
 */
function refreshBindings(keyCount: number): void {
  currentKeyCount = keyCount
  currentBindings = bindingsFor(keyCount)
  engine?.setKeyBindings(currentBindings)
  renderKeymap()
  renderKeyHint()
}

/** 重新绘制按键映射区。 */
function renderKeymap(): void {
  keymapElement.replaceChildren()

  for (let lane = 0; lane < currentKeyCount; lane++) {
    const item = document.createElement('div')
    item.className = 'keymap-item'

    const label = document.createElement('span')
    label.className = 'keymap-lane'
    label.textContent = `第 ${lane + 1} 轨`

    const button = document.createElement('button')
    button.type = 'button'
    button.className = capturingLane === lane ? 'keymap-key is-capturing' : 'keymap-key'
    button.textContent =
      capturingLane === lane ? '按下按键…' : formatKeyCode(currentBindings[lane] ?? '')
    button.addEventListener('click', () => beginCapture(lane))

    item.append(label, button)
    keymapElement.append(item)
  }
}

/** 刷新播放区里的键位提示。 */
function renderKeyHint(): void {
  keyHint.textContent = currentBindings.map((code) => formatKeyCode(code)).join('  ')
}

/** 进入「等待按键」状态。 */
function beginCapture(lane: number): void {
  capturingLane = lane
  // 捕获期间关掉游戏输入，否则按下一个已绑定的键会同时触发捕获和判定
  engine?.setInputEnabled(false)
  renderKeymap()
  setStatus(keymapStatus, '请按下要绑定的键…（Esc 取消）')
}

/** 退出「等待按键」状态。 */
function endCapture(message = ''): void {
  capturingLane = -1
  engine?.setInputEnabled(true)
  renderKeymap()
  setStatus(keymapStatus, message)
}

/**
 * 捕获阶段处理按键。
 *
 * 只有正在等按键时才会拦下事件，平时完全不干预 —— 否则会把游戏输入也吃掉。
 */
function captureKeyDown(event: KeyboardEvent): void {
  if (capturingLane < 0) return

  event.preventDefault()
  event.stopPropagation()

  const lane = capturingLane

  if (event.code === 'Escape') {
    endCapture('已取消。')
    return
  }

  if (MODIFIER_CODES.has(event.code)) {
    setStatus(keymapStatus, '修饰键不能用作轨道键（Alt 还会抢走焦点），请换一个。', true)
    return
  }

  const next = [...currentBindings]
  const occupiedBy = next.indexOf(event.code)

  let message: string
  if (occupiedBy >= 0 && occupiedBy !== lane) {
    // 按到了另一条轨道已经占用的键 → 直接对调。
    // 拒绝的话用户得先想办法把那条清空，非常别扭。
    next[occupiedBy] = next[lane] ?? ''
    next[lane] = event.code
    message = `「${formatKeyCode(event.code)}」原本在第 ${occupiedBy + 1} 轨，已与第 ${lane + 1} 轨对调。`
  } else {
    next[lane] = event.code
    message = `第 ${lane + 1} 轨已绑定「${formatKeyCode(event.code)}」。`
  }

  currentBindings = next
  // 立刻持久化：用户改了键位却忘了点保存而丢掉的体验很糟
  settings = updateSettings({ keyBindings: [...currentBindings] })
  engine?.setKeyBindings(currentBindings)
  renderKeyHint()

  endCapture(message)
}

// ---------------------------------------------------------------------------
// 结算面板
// ---------------------------------------------------------------------------

function bindResult(): void {
  resultRetry.addEventListener('click', () => {
    resultOverlay.hidden = true
    lastStats = null
    void engine?.restart()
  })

  resultBack.addEventListener('click', backToImport)

  resultFixOffset.addEventListener('click', () => {
    if (lastStats === null || lastStats.meanOffsetSamples === 0) return

    // 修正式推导：
    //   offset = 音符时间 - 实际命中的歌曲时间
    //   而 实际命中的歌曲时间 里已经加上了 audioOffsetMs
    //   所以要让平均 offset 归零，只需把 audioOffsetMs 加上这个平均值本身。
    const corrected = clamp(
      settings.audioOffsetMs + lastStats.meanOffsetMs,
      -AUDIO_OFFSET_LIMIT,
      AUDIO_OFFSET_LIMIT,
    )

    settings = updateSettings({ audioOffsetMs: corrected })
    engine?.setAudioOffset(corrected)
    offsetInput.value = String(corrected)
    offsetValue.textContent = formatOffset(corrected)

    resultFixOffset.disabled = true
    setStatus(
      resultOffset,
      `已把音频偏移调整为 ${formatOffset(corrected)} ms。再打一局验证一下偏差是否已经接近 0。`,
    )
  })
}

/** 一局结束时由引擎回调。 */
function showResult(stats: JudgeStats): void {
  lastStats = stats

  // 全连击徽标。判据和 canvas 上那个庆祝动画完全一致：
  // 一个 Miss 就会把连击清零，所以「最大连击 == 音符总数」等价于整首一个都没漏。
  resultFullCombo.hidden = !(stats.total > 0 && stats.maxCombo === stats.total)

  const rank = rankFor(stats.accuracy)
  resultRank.textContent = rank
  resultRank.style.color = RANK_COLORS[rank] ?? 'var(--accent)'

  resultScore.textContent = stats.score.toLocaleString('en-US')
  resultAccuracy.textContent = `${(stats.accuracy * 100).toFixed(2)}%`
  resultMaxCombo.textContent = String(stats.maxCombo)

  resultCounts.replaceChildren()
  for (let grade = 0; grade < GRADE_LABELS.length; grade++) {
    const item = document.createElement('li')

    const name = document.createElement('span')
    name.className = 'count-name'
    name.textContent = GRADE_LABELS[grade]
    name.style.color = GRADE_COLORS[grade]

    const value = document.createElement('span')
    value.className = 'count-value'
    value.textContent = String(stats.counts[grade] ?? 0)

    item.append(name, value)
    resultCounts.append(item)
  }

  if (stats.meanOffsetSamples >= 20) {
    setStatus(
      resultOffset,
      `本局平均偏差 ${formatOffset(stats.meanOffsetMs)} ms（${stats.meanOffsetSamples} 个有效样本）。` +
        '这个数字稳定地偏离 0 就说明存在系统性延迟，可以用下面的按钮一次修正。',
    )
    resultFixOffset.disabled = Math.abs(stats.meanOffsetMs) < 1
  } else {
    setStatus(
      resultOffset,
      `有效样本只有 ${stats.meanOffsetSamples} 个，样本太少，不足以做延迟校准。`,
    )
    resultFixOffset.disabled = true
  }

  resultOverlay.hidden = false
}

/** 按准确率给出评级。 */
function rankFor(accuracy: number): string {
  if (accuracy >= 1) return 'SS'
  if (accuracy >= 0.95) return 'S'
  if (accuracy >= 0.9) return 'A'
  if (accuracy >= 0.8) return 'B'
  if (accuracy >= 0.7) return 'C'
  return 'D'
}

const RANK_COLORS: Record<string, string> = {
  SS: '#ffd24d',
  S: '#8fe3ff',
  A: '#7ad9a0',
  B: '#4da3ff',
  C: '#ff9a5c',
  D: '#ff5c7a',
}

// ---------------------------------------------------------------------------
// 调试 HUD
// ---------------------------------------------------------------------------

const HUD_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['状态', '—'],
  ['分数', '—'],
  ['准确率', '—'],
  ['连击 / 最大连击', '—'],
  ['歌曲时间', '—'],
  ['进度', '—'],
  ['帧率', '—'],
  ['下落时间', '—'],
  ['轨道倾斜', '—'],
  ['滚动速度', '—'],
  ['当前 SV 倍率', '—'],
  ['累积滚动距离 S(now)', '—'],
  ['音符（已过线 / 总数）', '—'],
  ['判定（已判 / 总数）', '—'],
  ['当前 BPM', '—'],
]

const hudCells = new Map<string, HTMLElement>()

function buildHud(): void {
  hudElement.replaceChildren()
  for (const [label, initial] of HUD_ROWS) {
    const term = document.createElement('dt')
    term.textContent = label
    const value = document.createElement('dd')
    value.textContent = initial
    hudElement.append(term, value)
    hudCells.set(label, value)
  }
}

/** HUD 上一次刷新的时刻，用于节流 */
let lastHudAt = 0

function renderHud(metrics: EngineMetrics): void {
  // 播放按钮要立刻反映状态，所以不参与节流
  playBtn.textContent = metrics.playing ? '暂停' : '播放'

  // HUD 只是给人看的，每秒刷 10 次足够。
  // 每帧都写十几个 DOM 节点的文本会白白触发大量样式重算和重排。
  const now = performance.now()
  if (now - lastHudAt < 100) return
  lastHudAt = now

  const { stats } = metrics
  setHud('状态', metrics.playing ? '播放中' : '已暂停')
  setHud('分数', stats.score.toLocaleString('en-US'))
  setHud('准确率', `${(stats.accuracy * 100).toFixed(2)}%`)
  setHud('连击 / 最大连击', `${stats.combo} / ${stats.maxCombo}`)
  setHud('歌曲时间', `${(metrics.songTimeMs / 1000).toFixed(3)} s`)
  setHud('进度', `${formatDuration(metrics.songTimeMs)} / ${formatDuration(metrics.durationMs)}`)
  setHud('帧率', `${metrics.fps.toFixed(0)} fps`)
  setHud('下落时间', `${metrics.fallTimeMs} ms`)
  setHud('轨道倾斜', metrics.tiltDegrees > 0 ? `${metrics.tiltDegrees}°` : '关闭')
  setHud('滚动速度', `${metrics.speedPxPerMs.toFixed(3)} px/ms`)
  setHud('当前 SV 倍率', `${metrics.svMultiplier.toFixed(3)} ×`)
  // 这一项最能说明"积分模型"：它是从歌曲开头一路累积到现在的滚动距离，
  // 会随时间线性增长；有 SV 时它的斜率会跟着变；改下落时间时斜率立刻改变。
  setHud('累积滚动距离 S(now)', `${metrics.scrollDistance.toFixed(0)} px`)
  setHud('音符（已过线 / 总数）', `${metrics.passedNotes} / ${metrics.noteCount}`)
  setHud('判定（已判 / 总数）', `${stats.judged} / ${stats.total}`)

  if (currentBpmSegments !== null && currentBpmSegments.length > 0) {
    setHud('当前 BPM', bpmAt(currentBpmSegments, metrics.songTimeMs).toFixed(2))
  }
}

function setHud(label: string, value: string): void {
  const cell = hudCells.get(label)
  if (cell !== undefined) cell.textContent = value
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type PanelName = 'import' | 'pick' | 'play'

function showPanel(name: PanelName): void {
  importPanel.hidden = name !== 'import'
  pickPanel.hidden = name !== 'pick'
  playPanel.hidden = name !== 'play'

  // 容器要不要放宽、信息栏要不要占位，都由 body 类驱动（见 style.css）。
  // 容器一变宽，.stage 跟着变宽，引擎的 ResizeObserver 会自动重算布局和轨宽。
  syncLayoutClasses()
}

function setStatus(element: HTMLElement, text: string, isError = false): void {
  element.textContent = text
  element.classList.toggle('is-error', isError)
}

function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const totalSeconds = Math.floor(safe / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** 带符号的毫秒数，正数显式带 +，方便一眼看出偏向哪边。 */
function formatOffset(ms: number): string {
  const rounded = Math.round(ms * 10) / 10
  return rounded > 0 ? `+${rounded}` : String(rounded)
}

/** 把字节数写成人类看得懂的形式。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // 小于 100 的数值保留一位小数，读起来更精确；再大就没必要了
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** 把时间戳写成 YYYY-MM-DD HH:MM。 */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '未知时间'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
