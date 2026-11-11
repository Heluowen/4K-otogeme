#include "osu.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "common.h"
#include "str.h"

/* ===========================================================================
 * 小工具
 * ========================================================================= */

/** 写错误信息（可为 NULL）。 */
static void set_err(char *err, size_t err_len, const char *fmt, ...)
{
    if (err == NULL || err_len == 0) {
        return;
    }
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, err_len, fmt, ap);
    va_end(ap);
}

/** 对齐 JavaScript 的 `Math.round(Number(s))`：四舍五入、.5 向 +∞。 */
static int to_int_js(const char *s, int fallback)
{
    double v = 0.0;
    if (s == NULL || !str_parse_double(s, &v) || !isfinite(v)) {
        return fallback;
    }
    /* floor(v + 0.5) 正好等价于 Math.round 的「.5 向上」语义。 */
    return (int)floor(v + 0.5);
}

/** 对齐 JavaScript 的 `Number(s)`，非数字时用 fallback。 */
static double to_number_js(const char *s, double fallback)
{
    double v = 0.0;
    if (s == NULL || !str_parse_double(s, &v) || !isfinite(v)) {
        return fallback;
    }
    return v;
}

/* ===========================================================================
 * 键值表（对应 TS 里的 Map<string, string>）
 *
 * 用线性查找而不是哈希表：一个段里的键最多几十个，线性查找比哈希更简单、
 * 更快、也不会写错。这就是「按规模选数据结构」。
 * ========================================================================= */

typedef struct {
    char **key;
    char **value;
    size_t count;
    size_t cap;
} kv_list;

static void kv_free(kv_list *l)
{
    for (size_t i = 0; i < l->count; i++) {
        free(l->key[i]);
        free(l->value[i]);
    }
    free(l->key);
    free(l->value);
    l->key = NULL;
    l->value = NULL;
    l->count = 0;
    l->cap = 0;
}

/** 设置一个键值。同一个键重复出现时**后者覆盖前者**（与 Map.set 一致）。 */
static void kv_set(kv_list *l, const char *key, const char *value)
{
    for (size_t i = 0; i < l->count; i++) {
        if (strcmp(l->key[i], key) == 0) {
            free(l->value[i]);
            l->value[i] = xstrdup(value);
            return;
        }
    }

    if (l->count == l->cap) {
        l->cap = (l->cap == 0) ? 16 : l->cap * 2;
        l->key = xrealloc(l->key, l->cap * sizeof(char *));
        l->value = xrealloc(l->value, l->cap * sizeof(char *));
    }
    l->key[l->count] = xstrdup(key);
    l->value[l->count] = xstrdup(value);
    l->count++;
}

/** 取键值；不存在返回 NULL。 */
static const char *kv_get(const kv_list *l, const char *key)
{
    for (size_t i = 0; i < l->count; i++) {
        if (strcmp(l->key[i], key) == 0) {
            return l->value[i];
        }
    }
    return NULL;
}

/* ===========================================================================
 * 动态数组
 * ========================================================================= */

static void push_timing_point(osu_beatmap *bm, size_t *cap, osu_timing_point tp)
{
    if (bm->timing_count == *cap) {
        *cap = (*cap == 0) ? 64 : *cap * 2;
        bm->timing_points = xrealloc(bm->timing_points, *cap * sizeof(osu_timing_point));
    }
    bm->timing_points[bm->timing_count++] = tp;
}

static void push_hit_object(osu_beatmap *bm, size_t *cap, osu_hit_object ho)
{
    if (bm->hit_count == *cap) {
        *cap = (*cap == 0) ? 128 : *cap * 2;
        bm->hit_objects = xrealloc(bm->hit_objects, *cap * sizeof(osu_hit_object));
    }
    bm->hit_objects[bm->hit_count++] = ho;
}

/* ===========================================================================
 * 单行解析
 * ========================================================================= */

/**
 * 解析一行 `[TimingPoints]`：
 *
 *   time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
 *   0   ,500       ,4    ,2        ,0          ,100   ,1          ,0
 *
 * ⚠️ 注意第 7 列（uninherited）在 TS 版里是**字符串比较** `parts[6].trim() !== '0'`，
 *    不是数值比较。所以 "0" 才是绿线，其它任何写法（包括 "0.0"）都算红线。
 *    这里刻意保持同样的行为，好让两边可以对拍。
 */
static int parse_timing_point(char *line, osu_timing_point *out)
{
    char *fields[8];
    int n = str_split(line, ',', fields, 8);
    if (n < 2) {
        return 0;
    }

    double time_v = 0.0;
    double beat_v = 0.0;
    if (!str_parse_double(fields[0], &time_v) || !str_parse_double(fields[1], &beat_v)) {
        return 0;
    }
    if (!isfinite(time_v) || !isfinite(beat_v)) {
        return 0;
    }
    /* beatLength 为 0 的点没有意义（除零会得到无穷大的 BPM），直接丢弃。 */
    if (beat_v == 0.0) {
        return 0;
    }

    /* 时间在 .osu 里永远是整数；这里显式截断，并在文档里注明。 */
    out->time = (int64_t)time_v;
    out->beat_length = beat_v;

    if (n >= 7) {
        char *flag = str_trim_inplace(fields[6]);
        out->uninherited = (strcmp(flag, "0") != 0) ? 1 : 0;
    } else {
        /* 很老的格式（v3/v4）只有前两列，那时所有点都是 BPM 点。 */
        out->uninherited = 1;
    }
    return 1;
}

/**
 * 解析一行 `[HitObjects]`：
 *
 *   x,y,time,type,hitSound,objectParams,hitSample
 *
 * mania 下：
 *   - type & 1   → 单点音符
 *   - type & 128 → 长条（Hold）
 *   - 长条的第 6 列是 `结束时间:hitSample...`，取第一个冒号之前的部分
 */
static int parse_hit_object(char *line, osu_hit_object *out)
{
    char *fields[8];
    int n = str_split(line, ',', fields, 8);
    if (n < 5) {
        return 0;
    }

    double x_v = 0.0;
    double time_v = 0.0;
    double type_v = 0.0;
    if (!str_parse_double(fields[0], &x_v)) {
        return 0;
    }
    if (!str_parse_double(fields[2], &time_v)) {
        return 0;
    }
    if (!str_parse_double(fields[3], &type_v)) {
        return 0;
    }
    if (!isfinite(x_v) || !isfinite(time_v) || !isfinite(type_v)) {
        return 0;
    }

    /* JS 的位运算会先做 ToInt32。超出 int32 范围的值在本文件里不可能出现，
     * 但直接把 double 硬转成 int32 是未定义行为，所以先夹一下。 */
    int32_t type = 0;
    if (type_v >= -2147483648.0 && type_v <= 2147483647.0) {
        type = (int32_t)type_v;
    }

    out->x = x_v;
    out->time = (int64_t)time_v;
    out->end_time = out->time;
    out->is_hold = (type & 128) != 0;

    if (out->is_hold && n >= 6) {
        /* 第 6 列形如 `2000:0:0:0:0:`，只取冒号之前的部分。 */
        char *colon = strchr(fields[5], ':');
        if (colon != NULL) {
            *colon = '\0';
        }
        double parsed = 0.0;
        /* 只有比起点晚才算合法长条，否则当作单点处理 ——
         * 避免出现零长度甚至负长度的音符。 */
        if (str_parse_double(fields[5], &parsed) && isfinite(parsed) && parsed > time_v) {
            out->end_time = (int64_t)parsed;
        }
    }

    return 1;
}

/** 跳过空格和制表符。 */
static const char *skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t') {
        p++;
    }
    return p;
}

/**
 * 匹配 `[Events]` 里的引号形式背景事件：`0\s*,\s*0\s*,\s*"文件名"`。
 *
 * ⚠️ 不能简单地按逗号切分 —— 文件名里完全可能带逗号（`"bg, night.jpg"`），
 *    那样会被切成两半。所以优先按引号取。
 */
static int match_quoted_bg(const char *line, const char **name, size_t *len)
{
    const char *p = skip_ws(line);
    if (*p != '0') {
        return 0;
    }
    p = skip_ws(p + 1);
    if (*p != ',') {
        return 0;
    }
    p = skip_ws(p + 1);
    if (*p != '0') {
        return 0;
    }
    p = skip_ws(p + 1);
    if (*p != ',') {
        return 0;
    }
    p = skip_ws(p + 1);
    if (*p != '"') {
        return 0;
    }
    p++;

    const char *q = strchr(p, '"');
    if (q == NULL) {
        return 0;
    }
    *name = p;
    *len = (size_t)(q - p);
    return 1;
}

/**
 * 解析 `[Events]` 里的一行背景事件，返回**新分配**的文件名。
 *
 * 格式：`0,0,"bg.jpg",0,0`（类型 0 = 背景图；类型 1 是视频，其它是 storyboard 指令）。
 * 没匹配上返回 NULL。
 */
static char *parse_background_event(const char *line)
{
    const char *name = NULL;
    size_t nlen = 0;

    if (match_quoted_bg(line, &name, &nlen)) {
        char *tmp = xstrndup(name, nlen);
        char *trimmed = str_trim_inplace(tmp);
        char *out = (*trimmed == '\0') ? NULL : xstrdup(trimmed);
        free(tmp);
        return out;
    }

    /* 没写引号的老格式：0,0,bg.jpg */
    const char *c1 = strchr(line, ',');
    if (c1 == NULL) {
        return NULL;
    }
    const char *c2 = strchr(c1 + 1, ',');
    if (c2 == NULL) {
        return NULL;
    }

    char head0[32];
    size_t n0 = (size_t)(c1 - line);
    if (n0 >= sizeof head0) {
        return NULL;
    }
    memcpy(head0, line, n0);
    head0[n0] = '\0';
    if (strcmp(str_trim_inplace(head0), "0") != 0) {
        return NULL;
    }

    char head1[32];
    size_t n1 = (size_t)(c2 - (c1 + 1));
    if (n1 >= sizeof head1) {
        return NULL;
    }
    memcpy(head1, c1 + 1, n1);
    head1[n1] = '\0';
    if (strcmp(str_trim_inplace(head1), "0") != 0) {
        return NULL;
    }

    const char *rest = c2 + 1;
    const char *c3 = strchr(rest, ',');
    size_t n2 = (c3 == NULL) ? strlen(rest) : (size_t)(c3 - rest);

    char *tmp = xstrndup(rest, n2);
    char *t = str_trim_inplace(tmp);
    size_t tl = strlen(t);

    /* 对应 TS 的 `.replace(/^"|"$/g, '')`：各去掉一个引号，不是去掉一对。 */
    if (tl >= 2 && t[0] == '"' && t[tl - 1] == '"') {
        t[tl - 1] = '\0';
        t++;
    } else if (tl >= 1 && t[0] == '"') {
        t++;
    } else if (tl >= 1 && t[tl - 1] == '"') {
        t[tl - 1] = '\0';
    }

    char *out = (*t == '\0') ? NULL : xstrdup(t);
    free(tmp);
    return out;
}

/* ===========================================================================
 * 排序
 * ========================================================================= */

/**
 * 按时间做**稳定**插入排序。
 *
 * 为什么必须稳定：同一时刻出现的多个时间点，osu 的语义是「文件里靠后的生效」。
 * 不稳定排序会把它们的相对顺序打乱，导致变速结果取决于排序实现的内部细节。
 *
 * 为什么用插入排序而不是 qsort：C 标准库的 qsort **不保证稳定**，
 * 而且要把它改造成稳定版本还得额外带下标。时间点数量通常在几十到几千，
 * 插入排序的 O(n²) 在这个规模下完全够用。
 */
static void stable_sort_timing_points(osu_timing_point *a, size_t n)
{
    for (size_t i = 1; i < n; i++) {
        osu_timing_point key = a[i];
        size_t j = i;
        /* 严格大于才后移；相等时停下 —— 这就是稳定性。 */
        while (j > 0 && a[j - 1].time > key.time) {
            a[j] = a[j - 1];
            j--;
        }
        a[j] = key;
    }
}

/* ===========================================================================
 * 主解析
 * ========================================================================= */

osu_beatmap *osu_parse(const char *text, size_t len, char *err, size_t err_len)
{
    if (err != NULL && err_len > 0) {
        err[0] = '\0';
    }
    if (text == NULL) {
        set_err(err, err_len, "input is NULL");
        return NULL;
    }

    /* ── 1. 复制一份可写副本 ──
     * 解析过程需要原地修改文本（把分隔符改成 '\0'），而调用方的缓冲区
     * 可能是只读的（比如 HTTP 请求体）。所以先拷贝。 */
    char *work = xmalloc(len + 1);
    memcpy(work, text, len);
    work[len] = '\0';

    osu_beatmap *bm = xcalloc(1, sizeof *bm);
    kv_list general = {0};
    kv_list metadata = {0};
    kv_list difficulty = {0};
    size_t tp_cap = 0;
    size_t ho_cap = 0;

    /* ── 2. 剥掉 UTF-8 BOM ──
     * 不剥的话第一行的键名会多出一个不可见字符，导致后面的匹配全部失败。 */
    size_t pos = 0;
    if (len >= 3 && (unsigned char)work[0] == 0xEF && (unsigned char)work[1] == 0xBB &&
        (unsigned char)work[2] == 0xBF) {
        pos = 3;
    }

    /* 当前段名。指向 work 内部，不单独分配。
     * NULL 表示「还没遇到任何 [段名]」—— 那时只处理 `osu file format vN` 那一行。 */
    const char *section = NULL;

    /* ── 3. 逐行扫描 ──
     * 用下标扫描而不是 strchr('\n')：.osu 是文本，理论上不会有内嵌 '\0'，
     * 但按长度扫描能保证遇到 '\0' 也不会提前结束，行为更可预期。 */
    while (pos < len) {
        size_t start = pos;
        while (pos < len && work[pos] != '\n') {
            pos++;
        }
        size_t end = pos;
        if (pos < len) {
            pos++; /* 跳过 '\n' */
        }

        /* 就地打上字符串结尾，把这一行切出来（'work' 是我们自己的副本，随便改） */
        work[end] = '\0';

        char *line = str_trim_inplace(work + start);
        if (*line == '\0') {
            continue; /* 空行 */
        }
        if (str_starts_with(line, "//")) {
            continue; /* 注释行 */
        }

        /* 段头：[General] [Metadata] ... */
        size_t line_len = strlen(line);
        if (line[0] == '[' && line_len >= 2 && line[line_len - 1] == ']') {
            line[line_len - 1] = '\0';
            section = line + 1;
            continue;
        }

        /* 还没进入任何段：只可能是首行 `osu file format v14` */
        if (section == NULL) {
            int version = 0;
            if (sscanf(line, "osu file format v%d", &version) == 1) {
                bm->format_version = version;
            }
            continue;
        }

        if (strcmp(section, "TimingPoints") == 0) {
            osu_timing_point tp;
            if (parse_timing_point(line, &tp)) {
                push_timing_point(bm, &tp_cap, tp);
            }
            continue;
        }

        if (strcmp(section, "HitObjects") == 0) {
            osu_hit_object ho;
            if (parse_hit_object(line, &ho)) {
                push_hit_object(bm, &ho_cap, ho);
            }
            continue;
        }

        if (strcmp(section, "Events") == 0) {
            /* 一个谱面里可能有多条背景事件（改过谱面就会有），后写的生效。 */
            char *bg = parse_background_event(line);
            if (bg != NULL) {
                free(bm->background_filename);
                bm->background_filename = bg;
            }
            continue;
        }

        /* 其余段都是 `Key: Value`。
         * 用「第一个冒号」切分而不是找所有冒号，因为值里可能含冒号。 */
        const char *colon = strchr(line, ':');
        if (colon == NULL) {
            continue;
        }

        char *key_buf = xstrndup(line, (size_t)(colon - line));
        char *key = str_trim_inplace(key_buf);
        char *value = str_trim_inplace((char *)(colon + 1));

        if (strcmp(section, "General") == 0) {
            kv_set(&general, key, value);
        } else if (strcmp(section, "Metadata") == 0) {
            kv_set(&metadata, key, value);
        } else if (strcmp(section, "Difficulty") == 0) {
            kv_set(&difficulty, key, value);
        }

        free(key_buf);
    }

    /* ── 4. 收尾 ── */
    bm->audio_filename = xstrdup(kv_get(&general, "AudioFilename") ? kv_get(&general, "AudioFilename") : "");
    bm->mode = to_int_js(kv_get(&general, "Mode"), 0);
    bm->title = xstrdup(kv_get(&metadata, "Title") ? kv_get(&metadata, "Title") : "");
    bm->artist = xstrdup(kv_get(&metadata, "Artist") ? kv_get(&metadata, "Artist") : "");
    bm->creator = xstrdup(kv_get(&metadata, "Creator") ? kv_get(&metadata, "Creator") : "");
    bm->version = xstrdup(kv_get(&metadata, "Version") ? kv_get(&metadata, "Version") : "");
    /* mania 的键数就存在 CircleSize 里。缺省给 4，正好是主场景。 */
    bm->circle_size = to_number_js(kv_get(&difficulty, "CircleSize"), 4.0);
    bm->overall_difficulty = to_number_js(kv_get(&difficulty, "OverallDifficulty"), 5.0);

    if (bm->background_filename == NULL) {
        bm->background_filename = xstrdup("");
    }

    /* 时间点排序。hitObjects 不在这里排 —— TS 版是在 toChart 里排的。 */
    if (bm->timing_count > 1) {
        stable_sort_timing_points(bm->timing_points, bm->timing_count);
    }

    kv_free(&general);
    kv_free(&metadata);
    kv_free(&difficulty);
    free(work);

    return bm;
}

void osu_beatmap_free(osu_beatmap *bm)
{
    if (bm == NULL) {
        return;
    }
    free(bm->audio_filename);
    free(bm->background_filename);
    free(bm->title);
    free(bm->artist);
    free(bm->creator);
    free(bm->version);
    free(bm->timing_points);
    free(bm->hit_objects);
    free(bm);
}
