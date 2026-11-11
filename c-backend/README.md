# rhythm-4k C 后端

用 **C11 + Winsock2** 写的 HTTP 服务，为前端提供 `.osu` 谱面解析。

```
浏览器                                 C 后端
   │                                     │
   │ 1. 拖入 .osz                        │
   │ 2. DecompressionStream 解压（前端做） │
   │ 3. POST /api/parse  {.osu 文本}  ───▶│  osu_parser.c
   │                                     │  ├─ 分段扫描
   │ 4. ◀── JSON {meta, timingPoints,    │  ├─ TimingPoints
   │            hitObjects}              │  ├─ HitObjects
   │ 5. toChart() → 交给引擎             │  └─ Events
```

---

## 目录

- [1. 边界：为什么解压留在前端](#1-边界为什么解压留在前端)
- [2. 快速开始](#2-快速开始)
- [3. 模块结构](#3-模块结构)
- [4. HTTP 接口](#4-http-接口)
- [5. 内存管理约定](#5-内存管理约定)
- [6. 并发模型与权衡](#6-并发模型与权衡)
- [7. 安全](#7-安全)
- [8. 测试策略](#8-测试策略)
- [9. C 语言要点](#9-c-语言要点)
- [10. 与 TypeScript 版的语义对齐](#10-与-typescript-版的语义对齐)
- [11. 已知限制](#11-已知限制)
- [12. 移植到 Linux](#12-移植到-linux)

---

## 1. 边界：为什么解压留在前端

`.osz` 是个 zip，要读它就得解压。而 C 标准库**没有**解压函数，剪进一个 zlib 或者手写 DEFLATE 解码器是 400~500 行、并且和"解析谱面格式"毫无关系的代码。

所以边界划在这里：

| 环节 | 谁做 | 为什么 |
|---|---|---|
| 解压 zip | **前端**（浏览器自带 `DecompressionStream('deflate-raw')`） | 浏览器已经有了，不必重写 |
| 解析 `.osu` 文本 | **C 后端** | 这正是作业要展示的部分 |
| 轨道号换算、判定、渲染 | 前端 | 与 C 无关 |

于是 C 端只接收**纯文本**。API 因此也变得极简：`POST` 一段文本，返回一段 JSON。

> 如果将来确实需要在 C 里解压，`src/` 下新增一个 `inflate.c` 即可 —— 现有模块的接口不需要任何改动。

---

## 2. 快速开始

### 需要什么

- **C 编译器**：MinGW-w64 GCC（本机验证版本 16.1.0）或 MSVC
- **make**（可选）：`mingw32-make`

### 构建

```bat
:: 方式一：双击 / 命令行运行（不需要 make）
build.bat

:: 方式二：有 make 的话
mingw32-make
```

产物：`build/rhythm4k-server.exe`（约 96 KB，静态链接 libgcc/libwinpthread）

### 运行

```bat
:: 托管前端产物（先把前端构建好：npm run build）
build\rhythm4k-server.exe --root ..\dist

:: 指定端口
build\rhythm4k-server.exe --root ..\dist --port 9000

:: 只看启动信息，不打印每条请求
build\rhythm4k-server.exe --root ..\dist --quiet
```

从仓库根目录用 npm 脚本：

```bash
npm run cbuild     # 构建
npm run ctest      # 单元测试
npm run ccheck     # 全部验证（单元测试 + 对拍 + 端到端）
npm run cserve     # 起服务（--root dist）
```

### 命令行参数

| 参数 | 说明 |
|---|---|
| `--root <目录>` | 静态文件根目录，默认 `.` |
| `--port <端口>` | 监听端口，默认 `8080` |
| `--port-tries <次数>` | 端口被占用时往后试几个，默认 `10` |
| `--quiet` | 不打印每条请求 |
| `--parse <in.osu> [out.json]` | 解析谱面并输出 JSON（不起服务） |
| `--version` / `--help` | 版本 / 帮助 |

`--parse` 模式是给测试用的：前端对拍脚本需要拿**同一份输入**分别喂给两个解析器，有了它就不必为了测试去起一个 HTTP 服务。

```bat
build\rhythm4k-server.exe --parse ..\tools\fixture\chart.osu
```

---

## 3. 模块结构

19 个文件，2851 行（含测试）。

| 文件 | 行数 | 职责 |
|---|---:|---|
| `include/common.h` + `src/common.c` | 106 | 内存分配封装（失败即终止）、`fatal()` |
| `include/buf.h` + `src/buf.c` | 197 | 动态字节缓冲（2 倍增长、自动维护 `'\0'`） |
| `include/str.h` + `src/str.c` | 223 | trim / 切分 / 严格数字解析 |
| `include/json.h` + `src/json.c` | 107 | JSON 输出、字符串转义、最短往返浮点 |
| `include/osu.h` | 88 | `osu_beatmap` / `osu_timing_point` / `osu_hit_object` |
| `src/osu_parser.c` | **537** | `.osu` 解析器（本项目的核心） |
| `src/osu_json.c` | 85 | beatmap → JSON |
| `include/http.h` + `src/http.c` | 304 | HTTP 请求解析、响应构造、URL 解码 |
| `include/static.h` + `src/static.c` | 186 | 静态文件服务、MIME 表、路径穿越防护 |
| `include/server.h` + `src/server.c` | 367 | Winsock 服务器、`select` 循环、路由 |
| `src/main.c` | 184 | 入口、命令行解析 |
| `tests/test_osu.c` | 467 | 单元测试，77 条断言 |

### 依赖方向

```
main.c
  └── server.c ──┬── http.c ── buf.c ── common.c
                 ├── static.c ── http.c
                 │            └─ str.c
                 └── osu_parser.c ── str.c
                     └── osu_json.c ── json.c ── buf.c
```

单向、无环。底层（`common` / `buf` / `str`）不认识任何上层概念 —— 和前端 `core/` 的设计原则是同一条。

---

## 4. HTTP 接口

### `GET /api/health`

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```
```json
{
  "ok": true,
  "service": "rhythm-4k-c-backend",
  "version": "0.1.0",
  "features": ["osu-parse", "static"]
}
```

前端用它做**探测**：能拿到 `ok: true` 才走 C 解析，否则静默回落到内置 TypeScript 解析器。

### `POST /api/parse`

请求体就是 `.osu` 文件的原始文本（UTF-8）。

```http
POST /api/parse HTTP/1.1
Content-Type: text/plain; charset=utf-8

osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3
...
```

响应（字段名与 TypeScript 版 `parseOsu()` 的返回值**逐一对齐**）：

```json
{
  "ok": true,
  "formatVersion": 14,
  "audioFilename": "audio.mp3",
  "backgroundFilename": "bg, night.jpg",
  "mode": 3,
  "title": "Smoke Test",
  "artist": "Tester",
  "creator": "rhythm-4k",
  "version": "4K Test",
  "circleSize": 4,
  "overallDifficulty": 8,
  "timingPoints": [
    { "time": 0, "beatLength": 500, "uninherited": true },
    { "time": 1200, "beatLength": -50, "uninherited": false }
  ],
  "hitObjects": [
    { "x": 64, "time": 1000, "endTime": 1000, "isHold": false },
    { "x": 320, "time": 1500, "endTime": 2000, "isHold": true }
  ]
}
```

解析失败时：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
```
```json
{ "ok": false, "error": "parse failed" }
```

### 其它

- `GET /` 及其它路径 → 静态文件（`--root` 目录）
- `OPTIONS *` → `204`（跨源预检）
- 未知方法 → `405`
- 路径穿越 → `403`
- 所有响应都带 `Connection: close`，不支持 keep-alive

---

## 5. 内存管理约定

C 没有 GC，跨模块传递堆内存必须有明确规矩，否则必然泄漏或者重复释放。

### 规则

| 规则 | 说明 |
|---|---|
| **谁分配谁释放** | `osu_parse` 返回的 `osu_beatmap *` 必须由调用方 `osu_beatmap_free` |
| **`buf_t` 由持有者管理** | `buf_init` / `buf_free` 成对；内部 realloc 由 `buf` 自己负责 |
| **字符串一律 `xstrdup` 拷贝** | 解析器不保存指向调用方缓冲区的指针 —— 那是最常见的悬垂指针来源 |
| **`free(NULL)` 安全** | 所有 `*_free` 都先判 NULL，调用方不必写守卫 |
| **分配失败终止进程** | 见下 |

### 为什么分配失败直接退出

`xmalloc` / `xrealloc` 失败时打印原因并 `exit(1)`，不返回 NULL。

理由：

1. 这是个本地小服务器，单次响应最多几 MB。真 OOM 说明系统已经不对劲，继续跑只会输出更莫名其妙的结果。
2. C 没有异常。如果 `xmalloc` 可能返回 NULL，`buf_append`、`json_kv_string`、`osu_parse`… 全都要改成返回错误码，每个调用点都要写 `if`。这些噪声会淹没真正的业务逻辑。

这是**工程权衡**，不是偷懒。要真正做到可恢复，得换 arena 分配器或者把错误码贯穿到底 —— 那已经不是这份代码的目标了。

### 防御整数溢出

```c
void *xcalloc(size_t count, size_t size)
{
    // count * size 若超过 SIZE_MAX，乘法会回绕成一个很小的值，
    // 于是"分配了一小块，却按大块去写"—— 经典的堆溢出漏洞。
    // 用除法判断而不是乘法，可以完全避开回绕。
    if (count != 0 && size > SIZE_MAX / count) {
        fatal("allocation overflow (%zu * %zu)", count, size);
    }
    ...
}
```

---

## 6. 并发模型与权衡

**单线程 + `select()`**。

```c
for (;;) {
    fd_set readfds;
    FD_ZERO(&readfds);
    FD_SET(listener, &readfds);

    int ready = select(0, &readfds, NULL, NULL, NULL);
    if (ready == SOCKET_ERROR) break;
    if (ready > 0 && FD_ISSET(listener, &readfds)) {
        SOCKET client = accept(listener, NULL, NULL);
        handle_connection(client, opt->root, opt->quiet);   // 同步处理
    }
}
```

### 为什么不上线程

客户端只有一个（本机浏览器），请求量是每秒个位数。为这个场景上线程池只会引入锁、竞态和更难调试的崩溃。

而且 select 的"事件循环"模型和 Node 是同一个思路 —— 恰好也方便对照阅读原来的 `tools/serve-static.mjs`。

### 已知代价

连接是**同步处理**的：读完 → 处理 → 写回 → 关闭。一个极慢的客户端会短暂占住主循环。

兜底手段：`SO_RCVTIMEO` / `SO_SNDTIMEO` 都设成 5 秒，超时就直接关掉。

对本机自娱自乐够用；要扛公网流量得换成每连接一线程或者 IOCP。

### TCP 是字节流，没有消息边界

这是新手最容易搞错的地方。**不能假设"一次 `recv` 就是一个完整请求"**：

```c
/* 两阶段：先把头部读完（才知道 Content-Length），再按长度把体读完。 */
if (!parsed) {
    if (http_parse_request(out->data, out->len, req, body_offset) == 0) {
        parsed = 1;
        body_len = req->content_length;   // 现在才知道体有多长
    }
}
if (parsed && (long long)(out->len - *body_offset) >= body_len) {
    return 1;   // 收全了
}
```

分片和粘包都是常态。所有"假设一次读到一个完整请求"的代码，在稍微慢一点的网络或者大一点的请求上就会坏掉。

---

## 7. 安全

### 路径穿越

`GET /../../Windows/win.ini` 必须被挡掉。

关键点：**URL 解码在前，检查必须在解码之后**。否则 `%2e%2e%2f` 会绕过检查。

```c
static int path_is_safe(const char *path)
{
    // 反斜杠在 Windows 上也是分隔符，放行它等于给穿越开后门
    if (strchr(path, '\\') != NULL) return 0;

    // 逐段检查，任一段是 ".." 就拒绝
    const char *p = path;
    while (*p != '\0') {
        while (*p == '/') p++;
        const char *seg = p;
        while (*p != '\0' && *p != '/') p++;
        if ((size_t)(p - seg) == 2 && seg[0] == '.' && seg[1] == '.') return 0;
    }
    return 1;
}
```

逐个路径段检查，比"先拼接再规范化"更不容易出错 —— 那类实现经常在 `../` `..%2f` `....//` 这些变体上翻车。

**实测**（原始 socket，绕过客户端规范化）：

| 请求 | 结果 |
|---|---|
| `GET /..%2f..%2fWindows/win.ini` | `403` ✅ |
| `GET /%2e%2e/%2e%2e/Windows/win.ini` | `403` ✅ |
| `GET /assets/..%2f..%2fpackage.json` | `403` ✅ |
| `GET /assets/../../../index.html` | `403` ✅ |
| `GET /assets/index..js`（不是穿越） | `404` ✅（没有被误拦） |

### 只绑回环地址

```c
addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
```

这是本机自娱自乐的工具，不该对外网暴露。

### 请求体大小上限

头部 64 KB、体 32 MB。超过就直接断开 —— 防止一个畸形请求把内存吃光。

---

## 8. 测试策略

三层，由便宜到昂贵：

### ① 单元测试（`tests/test_osu.c`，77 条断言）

零框架：`check()` 记账，最后打印通过/失败数，失败返回非 0 退出码。C 里引框架反而增加依赖。

覆盖的边界：

- 缺段、缺字段、字段非法
- 长条的 `endTime` 比 `time` 还早（非法数据）
- `[Events]` 文件名里带逗号
- 同一时刻多个时间点的**稳定排序**
- JSON 字符串转义（引号/反斜杠/控制字符/UTF-8）
- 释放路径（`free(NULL)`、错误返回值）

```bash
npm run ctest
# 通过 77 项，失败 0 项
```

### ② 对拍：C ↔ TypeScript（`tools/c-backend-crosscheck.mjs`）

同一份 `.osu` 文本分别喂给两个解析器，输出规范化 JSON，**逐字节比较**。

这是最有说服力的验证方式：两个独立实现如果对真实谱面的每个字段都一致，就几乎不可能在同一个地方犯同样的错。相比之下，"读一遍代码觉得没问题"完全不值钱。

**实测结果**：fixture + 3 个真实谱面包共 11 个谱面，最大 5262 个音符 / 288,766 字符 JSON，**全部逐字节一致**。

```bash
npm run ccheck    # 会自动跑这个
```

### ③ 端到端（`tools/c-backend-e2e.mjs`）

把真实的 `src/osu/backend.ts` 直接 import 进来（它在 Node 里可加载，因为内部导入显式写了 `.ts`），分别在**有后端**和**无后端**两种情况下各跑一次，断言：

- 有后端时 `engine === 'c-backend'`
- 没后端时 `engine === 'builtin'` 且**不抛异常**
- 两条路解析出的谱面**完全一致**

必须换进程重测：探测结果是模块级状态，同一进程里第二次探测会直接吃缓存，测不出回落路径。

### 一条命令

```bash
npm run ccheck
```

```
================================================================
  汇总
================================================================
  ✓  C 单元测试
  ✓  对拍（4 个样本）
  ✓  端到端（真实 HTTP）

全部通过
```

---

## 9. C 语言要点

这一节是给"读这份代码学 C"的人写的 —— 列出代码里刻意展示的、C 特有的做法。

### 动态数组：2 倍增长

```c
void buf_reserve(buf_t *b, size_t extra)
{
    size_t need = b->len + extra + 1;   // +1 留给 '\0'
    if (need <= b->cap) return;

    size_t cap = b->cap;
    while (cap < need) {
        if (cap > SIZE_MAX / 2) { cap = need; break; }  // 翻倍前判溢出
        cap *= 2;
    }
    b->data = xrealloc(b->data, cap);
    b->cap = cap;
}
```

翻倍而不是每次 `+1`，让追加操作的**均摊复杂度是 O(1)**。

### 破坏性切分：C 里最高效的"split"

```c
int str_split(char *line, char sep, char **fields, int max)
{
    int count = 0;
    fields[count++] = line;
    for (char *p = line; *p != '\0'; p++) {
        if (*p == sep) {
            if (count >= max) break;     // 字段过多就地截断
            *p = '\0';                   // ★ 分隔符原位改成字符串结尾
            fields[count++] = p + 1;
        }
    }
    return count;
}
```

不复制任何字节，只把逗号变成 `'\0'`。代价是原始行被改写，所以调用方必须持有可写的副本 —— 这也是 `osu_parse` 一进来就 `xmalloc` 复制一份输入的原因（调用方的缓冲区可能是只读的 HTTP 请求体）。

### 稳定排序必须自己实现

C 标准库的 `qsort` **不保证稳定**。而 osu 的语义要求「同一时刻的多个时间点，文件里靠后的生效」，这依赖排序的稳定性。

```c
static void stable_sort_timing_points(osu_timing_point *a, size_t n)
{
    for (size_t i = 1; i < n; i++) {
        osu_timing_point key = a[i];
        size_t j = i;
        while (j > 0 && a[j - 1].time > key.time) {  // 严格大于才后移
            a[j] = a[j - 1];
            j--;
        }
        a[j] = key;   // 相等时停下 —— 这就是稳定性的来源
    }
}
```

用插入排序而不是 qsort：改造 qsort 成稳定版本还得额外带下标，而时间点数量通常在几十到几千，`O(n²)` 完全够用。

### UTF-8 必须按 unsigned char 处理

```c
// signed char 在遇到 >= 0x80 的字节时会变成负数，
// 比较 '< 0x20' 会误判。UTF-8 的多字节序列全部 >= 0x80，必须原样透传。
for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; p++) {
    unsigned char c = *p;
    if (c < 0x20) { /* \u00XX */ } else { /* 原样输出 */ }
}
```

这一行如果写成 `char c = *p`，中文曲名就会在 JSON 里被转义成一堆 `\u00xx`，前端解析出来是乱码。

### 浮点数的最短往返表示

```c
for (int prec = 15; prec <= 17; prec++) {
    snprintf(tmp, sizeof tmp, "%.*g", prec, v);
    if (strtod(tmp, NULL) == v) break;   // 能精确读回来就用它
}
```

直接用 `%g` 会丢精度，直接用 `%.17g` 会输出 `500.00000000000006` 这种噪音。从 15 位开始试，第一个能往返的就是最短的正确表示。

---

## 10. 与 TypeScript 版的语义对齐

C 和 JS 在做同一件事时有很多细微差别。为了能**逐字节对拍**，C 端刻意复刻了 JavaScript 的语义 —— 哪怕某些行为看起来反直觉。

### `Number('')` 是 0，不是 NaN

```javascript
Number('')            // 0
Number.isFinite(0)    // true
```

于是 `[Difficulty]` 里有一行空的 `OverallDifficulty:` 时，TS 得到的是 **0** 而不是默认值 5：

| 输入 | TS 结果 | C 结果 |
|---|---|---|
| 根本没有 `OverallDifficulty` 这一行 | 5（fallback） | 5 ✅ |
| `OverallDifficulty:`（空值） | **0**（`Number('')`） | **0** ✅ |
| `OverallDifficulty:abc` | 5（NaN → fallback） | 5 ✅ |

`str_parse_double` 就是为此写的：空串/全空白返回 0，非数字返回"失败"。

### 严格数字解析

裸 `strtod` 会把 `"12abc"` 解析成 12（只吃前缀）。要模拟 `Number()`，必须检查尾部没有残留：

```c
for (const char *p = end; *p != '\0'; p++) {
    if (!is_space_ch(*p)) return 0;   // '12abc' 必须判失败
}
```

### `uninherited` 是字符串比较，不是数值比较

```typescript
const uninherited = parts.length >= 7 ? parts[6].trim() !== '0' : true
```

注意 `!== '0'`：`"0.0"` 也算"红线"（BPM 点）。C 端用同样的字符串比较，而不是 `atoi(...) != 0`。

这个差异在真实谱面里几乎不会出现，但**对拍会失败** —— 而让对拍保持逐字节一致，是判断"两套实现真的等价"的唯一硬指标。

### 位运算是 ToInt32

```typescript
const isHold = (type & 128) !== 0    // JS 会先做 ToInt32
```

C 里直接把 `double` 转 `int32_t` 是**未定义行为**（超出范围时）。所以先夹范围：

```c
int32_t type = 0;
if (type_v >= -2147483648.0 && type_v <= 2147483647.0) {
    type = (int32_t)type_v;
}
```

### 精度损失的已知点

`.osu` 里的时间永远是整数。C 端用 `int64_t` 存，TS 端用 `number`。如果某个谱面写了 `1000.7` 这种非整数时间，两边会有差异（C 截断，TS 保留）。

**真实谱面不存在这种情况**，11 个真实谱面的对拍零差异就是证据。这是一个已知且可接受的限制。

---

## 11. 已知限制

| 限制 | 说明 |
|---|---|
| **仅 Windows** | 用 Winsock2。移植到 Linux 只需替换 socket 类型和初始化（见下节） |
| **不支持 chunked 编码** | 只按 `Content-Length` 读请求体 |
| **不支持 keep-alive** | 每个响应都 `Connection: close`，每次请求一个新连接 |
| **同步处理连接** | 慢客户端会短暂占住主循环（有 5 秒超时兜底） |
| **不解压 zip** | 边界划在前端，见第 1 节 |
| **单文件上传上限 32 MB** | 超过直接断开 |
| **不做 Zod 式 schema 校验** | 解析器是宽容的：坏行跳过，不整份报错 |

---

## 12. 移植到 Linux

绝大部分代码不用动。需要改的只有 socket 相关的少数几处：

| Windows | POSIX |
|---|---|
| `#include <winsock2.h>` | `#include <sys/socket.h>` `<netinet/in.h>` `<unistd.h>` |
| `WSAStartup` / `WSACleanup` | 不需要 |
| `SOCKET` / `INVALID_SOCKET` | `int` / `-1` |
| `closesocket(s)` | `close(s)` |
| `select(0, ...)` | `select(maxfd+1, ...)` |
| `ioctlsocket` | `fcntl` |
| `-lws2_32` | 不需要 |

`server.c` 里已经把这些差异集中得比较干净，主要改动在文件顶部的 include 块、`accept`/`close` 调用，以及 `select` 的第一个参数。

`buf.c` / `str.c` / `json.c` / `osu_parser.c` / `osu_json.c` / `static.c` / `http.c` **完全不需要改动** —— 这就是分层带来的好处。

---

## 附：一页纸速查

```
构建        build.bat   或   mingw32-make
测试        npm run ctest / npm run ccheck
运行        build\rhythm4k-server.exe --root ..\dist

接口        GET  /api/health       {"ok":true,"service":...}
            POST /api/parse        body=.osu 文本 → OsuBeatmap JSON
            GET  /                 静态文件

边界        解压 → 前端（DecompressionStream）
            解析 → C（osu_parser.c）
            换算/判定/渲染 → 前端

内存        osu_parse 分配 → 调用方 osu_beatmap_free
            buf_t 由持有者 buf_init/buf_free
            分配失败 = 终止进程（工程权衡，见第 5 节）

并发        单线程 select 循环 + 同步处理连接（5 秒超时兜底）

安全        逐段检查 ".."，在 URL 解码之后；只绑 127.0.0.1

对齐        与 TS 逐字节一致：11 个真实谱面，最大 5262 音符
            关键坑：Number('') === 0、uninherited 是字符串比较
```
