/**
 * test_osu.c —— .osu 解析器的单元测试。
 *
 * 零框架：一个 check() 记账，最后打印通过/失败数量，失败则返回非 0 退出码。
 * 这种做法在 C 里足够用（cexcept 之类的框架反而增加依赖），
 * 而且整个工程已经在用同样的风格（tools/smoke-test.mjs）。
 *
 * 重点覆盖的几类边界：
 *   - 缺段、缺字段、字段非法
 *   - 长条的 endTime 比 time 还早（非法数据）
 *   - Events 文件名里带逗号
 *   - 同一时刻多个时间点的**稳定排序**
 *   - JSON 字符串转义
 */
#include <stdio.h>
#include <string.h>

#include "buf.h"
#include "json.h"
#include "osu.h"

static int g_pass = 0;
static int g_fail = 0;

static void check(int ok, const char *label)
{
    if (ok) {
        g_pass++;
        printf("  ok    %s\n", label);
    } else {
        g_fail++;
        printf("  FAIL  %s\n", label);
    }
}

static void check_i64(const char *label, long long got, long long want)
{
    int ok = (got == want);
    if (ok) {
        g_pass++;
        printf("  ok    %s = %lld\n", label, got);
    } else {
        g_fail++;
        printf("  FAIL  %s\n        got  = %lld\n        want = %lld\n", label, got, want);
    }
}

static void check_double(const char *label, double got, double want)
{
    double diff = got - want;
    if (diff < 0) {
        diff = -diff;
    }
    int ok = (diff < 1e-9);
    if (ok) {
        g_pass++;
        printf("  ok    %s = %g\n", label, got);
    } else {
        g_fail++;
        printf("  FAIL  %s\n        got  = %g\n        want = %g\n", label, got, want);
    }
}

static void check_str(const char *label, const char *got, const char *want)
{
    const char *g = got != NULL ? got : "(null)";
    const char *w = want != NULL ? want : "(null)";
    int ok = (got != NULL && want != NULL && strcmp(got, want) == 0);
    if (ok) {
        g_pass++;
        printf("  ok    %s = \"%s\"\n", label, g);
    } else {
        g_fail++;
        printf("  FAIL  %s\n        got  = \"%s\"\n        want = \"%s\"\n", label, g, w);
    }
}

/** 解析一段字符串（辅助函数，失败时返回 NULL）。 */
static osu_beatmap *parse_str(const char *text)
{
    return osu_parse(text, strlen(text), NULL, 0);
}

/* 一份完整的样例谱面，后续多个测试都以它为基准。 */
static const char *SAMPLE =
    "osu file format v14\n"
    "\n"
    "[General]\n"
    "AudioFilename: audio.mp3\n"
    "Mode: 3\n"
    "\n"
    "[Metadata]\n"
    "Title:Smoke Test\n"
    "Artist:Tester\n"
    "Creator:rhythm-4k\n"
    "Version:4K Test\n"
    "\n"
    "[Difficulty]\n"
    "CircleSize:4\n"
    "OverallDifficulty:8\n"
    "\n"
    "[TimingPoints]\n"
    "0,500,4,2,0,100,1,0\n"
    "1200,-50,4,2,0,100,0,0\n"
    "\n"
    "[HitObjects]\n"
    "64,192,1000,1,0,0:0:0:0:\n"
    "320,192,1500,128,0,2000:0:0:0:0:\n";

static void test_basic(void)
{
    printf("\n[1] 基本解析\n");

    osu_beatmap *bm = parse_str(SAMPLE);
    check(bm != NULL, "解析成功");
    if (bm == NULL) {
        return;
    }

    check_i64("formatVersion", bm->format_version, 14);
    check_i64("mode", bm->mode, 3);
    check_str("title", bm->title, "Smoke Test");
    check_str("artist", bm->artist, "Tester");
    check_str("creator", bm->creator, "rhythm-4k");
    check_str("version", bm->version, "4K Test");
    check_str("audioFilename", bm->audio_filename, "audio.mp3");
    check_double("circleSize", bm->circle_size, 4.0);
    check_double("overallDifficulty", bm->overall_difficulty, 8.0);
    check_i64("timingCount", (long long)bm->timing_count, 2);
    check_i64("hitCount", (long long)bm->hit_count, 2);

    osu_beatmap_free(bm);
}

static void test_defaults(void)
{
    printf("\n[2] 缺省值\n");

    osu_beatmap *bm = parse_str("");
    check(bm != NULL, "空文本也能解析");
    if (bm != NULL) {
        check_i64("formatVersion 缺省 0", bm->format_version, 0);
        check_i64("mode 缺省 0", bm->mode, 0);
        check_double("circleSize 缺省 4", bm->circle_size, 4.0);
        check_double("overallDifficulty 缺省 5", bm->overall_difficulty, 5.0);
        check_str("title 缺省空串", bm->title, "");
        check_str("audioFilename 缺省空串", bm->audio_filename, "");
        check_str("backgroundFilename 缺省空串", bm->background_filename, "");
        check_i64("timingCount 0", (long long)bm->timing_count, 0);
        check_i64("hitCount 0", (long long)bm->hit_count, 0);
        osu_beatmap_free(bm);
    }

    /* 非法数值 → 回落默认值，而不是产生 NaN */
    bm = parse_str("[Difficulty]\nCircleSize:abc\nOverallDifficulty:abc\n");
    check(bm != NULL, "非法数值不崩");
    if (bm != NULL) {
        check_double("CircleSize 非法 → 4", bm->circle_size, 4.0);
        check_double("OD 非法 → 5", bm->overall_difficulty, 5.0);
        osu_beatmap_free(bm);
    }

    /*
     * ★ 「键缺失」和「键存在但值为空」是两种不同情况，结果也不同：
     *
     *     没有 OverallDifficulty 这一行   → 默认值 5
     *     OverallDifficulty:              → 0
     *
     * 后者看起来反直觉，但它是 JavaScript 的语义决定的：
     *     Number('') === 0，而 0 是有限数，所以 fallback 不会被采用。
     * C 端刻意复刻了这个行为（空串 → 0.0），否则对拍会失败。
     */
    bm = parse_str("[Difficulty]\nOverallDifficulty:\n");
    if (bm != NULL) {
        check_double("OD 空值 → 0（Number('')===0，与 TS 一致）", bm->overall_difficulty, 0.0);
        osu_beatmap_free(bm);
    }

    bm = parse_str("[Difficulty]\nCircleSize:4\n");
    if (bm != NULL) {
        check_double("OD 整行缺失 → 5", bm->overall_difficulty, 5.0);
        osu_beatmap_free(bm);
    }
}

static void test_bom_and_crlf(void)
{
    printf("\n[3] BOM 与换行\n");

    /* UTF-8 BOM 必须被剥掉，否则首行匹配失败 */
    const char *with_bom = "\xEF\xBB\xBFosu file format v15\n[General]\nMode: 3\n";
    osu_beatmap *bm = parse_str(with_bom);
    check(bm != NULL, "带 BOM 的文件能解析");
    if (bm != NULL) {
        check_i64("BOM 后 formatVersion = 15", bm->format_version, 15);
        check_i64("BOM 后 Mode = 3", bm->mode, 3);
        osu_beatmap_free(bm);
    }

    /* CRLF 换行 */
    bm = parse_str("osu file format v14\r\n[General]\r\nMode: 3\r\n");
    check(bm != NULL, "CRLF 换行能解析");
    if (bm != NULL) {
        check_i64("CRLF formatVersion", bm->format_version, 14);
        check_i64("CRLF mode", bm->mode, 3);
        osu_beatmap_free(bm);
    }
}

static void test_timing_points(void)
{
    printf("\n[4] TimingPoints\n");

    /* beatLength 为 0 的点必须被丢弃（否则算 BPM 会除零） */
    osu_beatmap *bm = parse_str("[TimingPoints]\n0,0,4,2,0,100,1,0\n");
    check(bm != NULL, "beatLength=0 不崩");
    if (bm != NULL) {
        check_i64("beatLength=0 被丢弃", (long long)bm->timing_count, 0);
        osu_beatmap_free(bm);
    }

    /* 非数字字段 */
    bm = parse_str("[TimingPoints]\nabc,500,4,2,0,100,1,0\n");
    if (bm != NULL) {
        check_i64("非数字 time 被丢弃", (long long)bm->timing_count, 0);
        osu_beatmap_free(bm);
    }

    /* 只有两列的老格式 → 默认是 BPM 点 */
    bm = parse_str("[TimingPoints]\n0,500\n");
    if (bm != NULL) {
        check_i64("两列格式能解析", (long long)bm->timing_count, 1);
        check(bm->timing_count == 1 && bm->timing_points[0].uninherited == 1,
              "两列格式默认 uninherited = true");
        osu_beatmap_free(bm);
    }

    /*
     * ★ 关键：第 7 列是**字符串比较**。
     * "0" → 绿线(SV)，"0.0" → 红线(BPM)。这和数值比较的结果不同，
     * 但必须和 TypeScript 版保持一致，否则对拍会失败。
     */
    bm = parse_str("[TimingPoints]\n0,500,4,2,0,100,0.0,0\n");
    if (bm != NULL) {
        check(bm->timing_count == 1 && bm->timing_points[0].uninherited == 1,
              "\"0.0\" 按字符串比较算红线（与 TS 一致）");
        osu_beatmap_free(bm);
    }
}

static void test_stable_sort(void)
{
    printf("\n[5] 时间点稳定排序\n");

    /* 同一时刻的三条，文件顺序是 3,1,2 —— 排序后必须还是 3,1,2 */
    osu_beatmap *bm = parse_str("[TimingPoints]\n"
                                "100,300,4,2,0,100,1,0\n"
                                "100,200,4,2,0,100,0,0\n"
                                "100,100,4,2,0,100,0,0\n");
    check(bm != NULL, "同刻时间点解析成功");
    if (bm != NULL) {
        check_i64("条数 3", (long long)bm->timing_count, 3);
        if (bm->timing_count == 3) {
            check_double("同刻保持文件顺序 [0] = 300", bm->timing_points[0].beat_length, 300.0);
            check_double("同刻保持文件顺序 [1] = 200", bm->timing_points[1].beat_length, 200.0);
            check_double("同刻保持文件顺序 [2] = 100", bm->timing_points[2].beat_length, 100.0);
        }
        osu_beatmap_free(bm);
    }

    /* 乱序输入必须被排好 */
    bm = parse_str("[TimingPoints]\n"
                   "300,500,4,2,0,100,1,0\n"
                   "100,400,4,2,0,100,1,0\n"
                   "200,300,4,2,0,100,1,0\n");
    if (bm != NULL) {
        int sorted = 1;
        for (size_t i = 1; i < bm->timing_count; i++) {
            if (bm->timing_points[i - 1].time > bm->timing_points[i].time) {
                sorted = 0;
            }
        }
        check(sorted, "乱序输入被按时间排好");
        if (bm->timing_count == 3) {
            check_i64("[0].time", bm->timing_points[0].time, 100);
            check_i64("[2].time", bm->timing_points[2].time, 300);
        }
        osu_beatmap_free(bm);
    }
}

static void test_hit_objects(void)
{
    printf("\n[6] HitObjects\n");

    osu_beatmap *bm = parse_str("[HitObjects]\n"
                                "64,192,1000,1,0,0:0:0:0:\n"      /* 单点 */
                                "320,192,1500,128,0,2000:0:0:0:0:\n" /* 长条 */
                                "448,192,1750,129,0,2200:0:0:0:0:\n" /* 1|128 = 也是长条 */
                                );
    check(bm != NULL, "解析成功");
    if (bm != NULL) {
        check_i64("条数 3", (long long)bm->hit_count, 3);
        if (bm->hit_count == 3) {
            check(bm->hit_objects[0].is_hold == 0, "type=1 不是长条");
            check_i64("单点 endTime == time", bm->hit_objects[0].end_time, 1000);
            check_double("x 保留原值", bm->hit_objects[0].x, 64.0);

            check(bm->hit_objects[1].is_hold == 1, "type=128 是长条");
            check_i64("长条 endTime", bm->hit_objects[1].end_time, 2000);

            check(bm->hit_objects[2].is_hold == 1, "type=129 (1|128) 也是长条");
            check_i64("type=129 endTime", bm->hit_objects[2].end_time, 2200);
        }
        osu_beatmap_free(bm);
    }

    /* 非法长条：endTime 比 time 还早 → 退化成单点，不能出现负长度音符 */
    bm = parse_str("[HitObjects]\n320,192,2000,128,0,1000:0:0:0:0:\n");
    if (bm != NULL) {
        check_i64("非法长条仍被收录", (long long)bm->hit_count, 1);
        if (bm->hit_count == 1) {
            check_i64("endTime <= time 时退化为 time", bm->hit_objects[0].end_time, 2000);
        }
        osu_beatmap_free(bm);
    }

    /* 字段不足或非数字 → 丢弃 */
    bm = parse_str("[HitObjects]\n64,192\nabc,192,1000,1,0\n");
    if (bm != NULL) {
        check_i64("残缺行被丢弃", (long long)bm->hit_count, 0);
        osu_beatmap_free(bm);
    }
}

static void test_events(void)
{
    printf("\n[7] Events 曲绘\n");

    /* 文件名里带逗号 —— 这是不能简单 split(',') 的原因 */
    osu_beatmap *bm = parse_str("[Events]\n0,0,\"bg, night.jpg\",0,0\n");
    if (bm != NULL) {
        check_str("带逗号的文件名完整保留", bm->background_filename, "bg, night.jpg");
        osu_beatmap_free(bm);
    }

    /* 没写引号的老格式 */
    bm = parse_str("[Events]\n0,0,bg.jpg\n");
    if (bm != NULL) {
        check_str("无引号老格式", bm->background_filename, "bg.jpg");
        osu_beatmap_free(bm);
    }

    /* 非背景图事件必须被忽略 */
    bm = parse_str("[Events]\n"
                   "1,0,\"video.avi\",0,0\n"
                   "2,5000,8000\n"
                   "3,128,0,1000:1:0:0:0:0\n");
    if (bm != NULL) {
        check_str("视频/休息段/bstoryboard 都不算曲绘", bm->background_filename, "");
        osu_beatmap_free(bm);
    }

    /* 多条背景事件 → 后写的生效 */
    bm = parse_str("[Events]\n0,0,\"first.png\",0,0\n0,0,\"second.png\",0,0\n");
    if (bm != NULL) {
        check_str("多条背景事件取最后一条", bm->background_filename, "second.png");
        osu_beatmap_free(bm);
    }

    /* 引号优先：同一行既有引号又不像简单分段 */
    bm = parse_str("[Events]\n0,0,\"a,b.c\\d\",0,0\n");
    if (bm != NULL) {
        check_str("反斜杠不当转义处理", bm->background_filename, "a,b.c\\d");
        osu_beatmap_free(bm);
    }
}

static void test_key_value(void)
{
    printf("\n[8] Key: Value\n");

    /* 值里含冒号：必须按**第一个**冒号切分 */
    osu_beatmap *bm = parse_str("[General]\nAudioFilename: disk:a.mp3\n");
    if (bm != NULL) {
        check_str("值里的冒号不被切开", bm->audio_filename, "disk:a.mp3");
        osu_beatmap_free(bm);
    }

    /* 同一个键重复出现 → 后者覆盖前者（Map 语义） */
    bm = parse_str("[Metadata]\nTitle:First\nTitle:Second\n");
    if (bm != NULL) {
        check_str("重复键后者生效", bm->title, "Second");
        osu_beatmap_free(bm);
    }

    /* 值的首尾空白被 trim */
    bm = parse_str("[Metadata]\nTitle:   spaced out   \n");
    if (bm != NULL) {
        check_str("值被 trim", bm->title, "spaced out");
        osu_beatmap_free(bm);
    }

    /* 注释行与空行被跳过 */
    bm = parse_str("[General]\n// Mode: 99\nMode: 3\n\n");
    if (bm != NULL) {
        check_i64("注释行被跳过", bm->mode, 3);
        osu_beatmap_free(bm);
    }
}

static void test_json_escape(void)
{
    printf("\n[9] JSON 字符串转义\n");

    buf_t b;
    buf_init(&b);

    json_write_string(&b, "a\"b\\c\nd\te");
    check_str("引号/反斜杠/换行/制表符转义", buf_cstr(&b), "\"a\\\"b\\\\c\\nd\\te\"");

    buf_clear(&b);
    json_write_string(&b, "\x01");
    check_str("控制字符转 \\u00XX", buf_cstr(&b), "\"\\u0001\"");

    /* UTF-8 中文必须原样输出（它由 >= 0x80 的多个字节组成） */
    buf_clear(&b);
    json_write_string(&b, "中文");
    check_str("UTF-8 原样输出", buf_cstr(&b), "\"中文\"");

    buf_clear(&b);
    json_write_string(&b, NULL);
    check_str("NULL 输出为空字符串", buf_cstr(&b), "\"\"");

    buf_free(&b);

    /* 数字：整数不能带小数点，小数要能往返 */
    buf_init(&b);
    buf_append_double(&b, 4.0);
    check_str("4.0 → \"4\"", buf_cstr(&b), "4");
    buf_clear(&b);
    buf_append_double(&b, 0.1);
    check_str("0.1 精确往返", buf_cstr(&b), "0.1");
    buf_free(&b);
}

static void test_no_leak_paths(void)
{
    printf("\n[10] 释放路径\n");

    /* free(NULL) 必须安全 */
    osu_beatmap_free(NULL);
    check(1, "osu_beatmap_free(NULL) 安全");

    /* 解析失败时不泄漏（这一条只能靠 ASan 之类的工具严格验证，
     * 这里至少确认返回值语义正确） */
    char err[64];
    osu_beatmap *bm = osu_parse(NULL, 0, err, sizeof err);
    check(bm == NULL, "NULL 输入返回 NULL");
    check(err[0] != '\0', "错误信息被填写");
}

int main(void)
{
    printf("rhythm-4k C backend —— .osu 解析器单元测试\n");

    test_basic();
    test_defaults();
    test_bom_and_crlf();
    test_timing_points();
    test_stable_sort();
    test_hit_objects();
    test_events();
    test_key_value();
    test_json_escape();
    test_no_leak_paths();

    printf("\n通过 %d 项，失败 %d 项\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
