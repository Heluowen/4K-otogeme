/**
 * buf.h —— 动态字节缓冲。
 *
 * C 里没有 String 类型，任何"可能变长的输出"都得自己管内存。
 * HTTP 响应头、JSON 输出、文件内容读取全都要用到，所以先把这个地基打好。
 *
 * 设计要点：
 *   - 容量按 2 倍增长（均摊 O(1) 追加）
 *   - 始终保证 data[len] 处能放一个 '\0'，方便临时当 C 字符串用
 *   - 分配失败直接终止（见 common.h 的说明），所以这些函数都没有返回值
 */
#ifndef R4K_BUF_H
#define R4K_BUF_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    unsigned char *data;
    size_t len; /* 已用字节数，不含结尾的 '\0' */
    size_t cap; /* 已分配字节数，恒 >= len + 1 */
} buf_t;

void buf_init(buf_t *b);
void buf_free(buf_t *b);
void buf_clear(buf_t *b);

/** 保证还能再追加 extra 个字节（外加结尾的 '\0'）。 */
void buf_reserve(buf_t *b, size_t extra);

void buf_append(buf_t *b, const void *data, size_t n);
void buf_append_str(buf_t *b, const char *s);
void buf_append_char(buf_t *b, char c);
void buf_append_u8(buf_t *b, unsigned char c);
void buf_appendf(buf_t *b, const char *fmt, ...);

/** 追加一个 64 位整数。 */
void buf_append_i64(buf_t *b, int64_t v);

/**
 * 追加一个浮点数，采用「最短往返」表示。
 *
 * 直接用 %g 会丢精度，直接用 %.17g 会输出 500.00000000000006 这种噪音。
 * 做法是从 15 位有效数字开始试，第一个能被 strtod 精确读回来的就用它 ——
 * 这样既保证 JSON 往返不丢精度，又不会吐出多余的尾数。
 */
void buf_append_double(buf_t *b, double v);

/**
 * 返回以 '\0' 结尾的内容指针。
 *
 * ⚠️ 返回的指针在下一次 append / reserve 之后可能失效（会 realloc）。
 *    要长期持有必须自己 xstrdup 一份。
 */
const char *buf_cstr(buf_t *b);

#endif /* R4K_BUF_H */
