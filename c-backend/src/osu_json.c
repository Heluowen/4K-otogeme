/**
 * osu_json.c —— 把 osu_beatmap 序列化成 JSON。
 *
 * 字段名、顺序、类型都与 TypeScript 版 `parseOsu()` 的返回值逐一对齐，
 * 这样前端可以把这份 JSON 直接当成 parseOsu 的结果使用，
 * 也让两边的解析器可以逐字段对拍。
 */
#include <string.h>

#include "buf.h"
#include "json.h"
#include "osu.h"

void osu_beatmap_to_json(buf_t *out, const osu_beatmap *bm)
{
    buf_append_char(out, '{');

    json_kv_bool(out, "ok", 1);
    buf_append_char(out, ',');

    json_kv_i64(out, "formatVersion", bm->format_version);
    buf_append_char(out, ',');

    json_kv_string(out, "audioFilename", bm->audio_filename);
    buf_append_char(out, ',');
    json_kv_string(out, "backgroundFilename", bm->background_filename);
    buf_append_char(out, ',');

    json_kv_i64(out, "mode", bm->mode);
    buf_append_char(out, ',');

    json_kv_string(out, "title", bm->title);
    buf_append_char(out, ',');
    json_kv_string(out, "artist", bm->artist);
    buf_append_char(out, ',');
    json_kv_string(out, "creator", bm->creator);
    buf_append_char(out, ',');
    json_kv_string(out, "version", bm->version);
    buf_append_char(out, ',');

    json_kv_double(out, "circleSize", bm->circle_size);
    buf_append_char(out, ',');
    json_kv_double(out, "overallDifficulty", bm->overall_difficulty);
    buf_append_char(out, ',');

    /* ── timingPoints ── */
    json_write_string(out, "timingPoints");
    buf_append_char(out, ':');
    buf_append_char(out, '[');
    for (size_t i = 0; i < bm->timing_count; i++) {
        const osu_timing_point *tp = &bm->timing_points[i];
        if (i > 0) {
            buf_append_char(out, ',');
        }
        buf_append_char(out, '{');
        json_kv_i64(out, "time", tp->time);
        buf_append_char(out, ',');
        json_kv_double(out, "beatLength", tp->beat_length);
        buf_append_char(out, ',');
        json_kv_bool(out, "uninherited", tp->uninherited);
        buf_append_char(out, '}');
    }
    buf_append_char(out, ']');
    buf_append_char(out, ',');

    /* ── hitObjects ── */
    json_write_string(out, "hitObjects");
    buf_append_char(out, ':');
    buf_append_char(out, '[');
    for (size_t i = 0; i < bm->hit_count; i++) {
        const osu_hit_object *ho = &bm->hit_objects[i];
        if (i > 0) {
            buf_append_char(out, ',');
        }
        buf_append_char(out, '{');
        json_kv_double(out, "x", ho->x);
        buf_append_char(out, ',');
        json_kv_i64(out, "time", ho->time);
        buf_append_char(out, ',');
        json_kv_i64(out, "endTime", ho->end_time);
        buf_append_char(out, ',');
        json_kv_bool(out, "isHold", ho->is_hold);
        buf_append_char(out, '}');
    }
    buf_append_char(out, ']');

    buf_append_char(out, '}');
}
