/**
 * osu.h —— `.osu` 文件的数据结构与解析。
 *
 * 这一层刻意与 TypeScript 版本的 `src/osu/parser.ts` **保持逐字段一致**，
 * 目的是两者可以互换、也可以互相比对（见 tests/ 里的对拍）。
 *
 * ============================ `.osu` 格式速览 ============================
 *
 *   osu file format v14          ← 首行，没有冒号也不在任何段内
 *
 *   [General]                    ← 段名用方括号
 *   AudioFilename: audio.mp3     ← 其余段都是 "Key: Value"
 *   Mode: 3                      ←   3 = mania
 *
 *   [Events]
 *   0,0,"bg, night.jpg",0,0      ← 逗号表格，但文件名里可能带逗号！
 *
 *   [TimingPoints]
 *   0,500,4,2,0,100,1,0          ← time,beatLength,...,uninherited,...
 *
 *   [HitObjects]
 *   64,192,1000,1,0,...          ← x,y,time,type,hitSound,...
 *
 * 解析策略：逐行扫描，靠 `[段名]` 切换上下文。
 * 这里**不做轨道号换算** —— 换算需要键数，而依赖"段在文件里的先后顺序"很脆弱，
 * 所以只保留原始 x，交给上层（前端 / toChart）统一换算。
 */
#ifndef R4K_OSU_H
#define R4K_OSU_H

#include <stddef.h>
#include <stdint.h>

#include "buf.h"

/** `[TimingPoints]` 里的一行。 */
typedef struct {
    int64_t time;
    /**
     * 第 2 列。含义取决于 uninherited：
     *   - BPM 点：每拍多少毫秒（120 BPM → 500）
     *   - SV 点：负数，真实倍率 = -100 / beat_length
     */
    double beat_length;
    /** 1 = BPM 点（红线），0 = SV 点（绿线）。 */
    int uninherited;
} osu_timing_point;

/** `[HitObjects]` 里的一行，保留原始坐标。 */
typedef struct {
    /** 原始 x 坐标，理论范围 0..512。 */
    double x;
    /** 到达判定线的时刻（ms）。 */
    int64_t time;
    /** 长条结束时刻；单点音符等于 time。 */
    int64_t end_time;
    /** 1 = 长条。 */
    int is_hold;
} osu_hit_object;

/** 一个 `.osu` 文件的解析结果。 */
typedef struct {
    int format_version;
    char *audio_filename;
    char *background_filename; /* 可能是空串，表示谱面没写曲绘 */
    int mode;
    char *title;
    char *artist;
    char *creator;
    char *version;
    double circle_size;       /* mania 下就是键数 */
    double overall_difficulty; /* OD，前端用它推导判定窗口 */

    /* 动态数组：容量在内部记录，外层只需要 count。 */
    osu_timing_point *timing_points;
    size_t timing_count;

    osu_hit_object *hit_objects;
    size_t hit_count;
} osu_beatmap;

/**
 * 解析一段 `.osu` 文本。
 *
 * @param text    文本内容（UTF-8，**不要求**以 '\0' 结尾）
 * @param len     字节数
 * @param err     失败时写入原因；可为 NULL
 * @param err_len err 缓冲区长度；建议至少 256
 * @return 成功返回堆上的结果（用完必须 osu_beatmap_free），失败返回 NULL
 */
osu_beatmap *osu_parse(const char *text, size_t len, char *err, size_t err_len);

/** 释放 osu_parse 返回的对象，可安全传入 NULL。 */
void osu_beatmap_free(osu_beatmap *bm);

/** 序列化成 JSON（字段名与 TypeScript 版 parseOsu 的返回值一致）。 */
void osu_beatmap_to_json(buf_t *out, const osu_beatmap *bm);

#endif /* R4K_OSU_H */
