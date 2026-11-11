#include "buf.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "common.h"

/** 初始容量。取 256 是因为绝大多数 HTTP 头和短 JSON 都能一次装下。 */
#define BUF_INIT_CAP 256

void buf_init(buf_t *b)
{
    b->data = xmalloc(BUF_INIT_CAP);
    b->len = 0;
    b->cap = BUF_INIT_CAP;
    b->data[0] = '\0';
}

void buf_free(buf_t *b)
{
    free(b->data);
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

void buf_clear(buf_t *b)
{
    b->len = 0;
    if (b->cap > 0) {
        b->data[0] = '\0';
    }
}

void buf_reserve(buf_t *b, size_t extra)
{
    /* +1 是留给结尾的 '\0'。 */
    size_t need = b->len + extra + 1;
    if (need <= b->cap) {
        return;
    }

    size_t cap = b->cap;
    while (cap < need) {
        /* 2 倍增长。注意 cap 已经是 size_t，翻倍可能溢出，所以要判上界。 */
        if (cap > SIZE_MAX / 2) {
            cap = need;
            break;
        }
        cap *= 2;
    }

    b->data = xrealloc(b->data, cap);
    b->cap = cap;
}

void buf_append(buf_t *b, const void *data, size_t n)
{
    if (n == 0) {
        return;
    }
    buf_reserve(b, n);
    memcpy(b->data + b->len, data, n);
    b->len += n;
    b->data[b->len] = '\0';
}

void buf_append_str(buf_t *b, const char *s)
{
    if (s == NULL) {
        return;
    }
    buf_append(b, s, strlen(s));
}

void buf_append_char(buf_t *b, char c)
{
    buf_reserve(b, 1);
    b->data[b->len] = (unsigned char)c;
    b->len += 1;
    b->data[b->len] = '\0';
}

void buf_append_u8(buf_t *b, unsigned char c)
{
    buf_reserve(b, 1);
    b->data[b->len] = c;
    b->len += 1;
    b->data[b->len] = '\0';
}

void buf_appendf(buf_t *b, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    /* 第一遍：只算长度。vsnprintf 传 size 0 时不会写任何东西，返回所需长度。 */
    int need = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);

    if (need < 0) {
        return;
    }

    buf_reserve(b, (size_t)need);

    va_start(ap, fmt);
    vsnprintf((char *)b->data + b->len, (size_t)need + 1, fmt, ap);
    va_end(ap);

    b->len += (size_t)need;
}

void buf_append_i64(buf_t *b, int64_t v)
{
    /* Windows 上 long 是 32 位，所以必须用 %lld 配 int64_t，
     * 并且显式转成 long long 才不会触发格式警告。 */
    buf_appendf(b, "%lld", (long long)v);
}

void buf_append_double(buf_t *b, double v)
{
    /* JSON 不允许 NaN / Infinity。这里统一写成 0 —— 上游如果算出这种值，
     * 说明数据本身有问题，但"返回一个能解析的 0"比"返回坏 JSON 让前端整个崩掉"更好。 */
    if (!isfinite(v)) {
        buf_append_char(b, '0');
        return;
    }

    char tmp[48];
    /* 17 位有效数字一定能精确往返 double，所以循环必然在某一轮成功。 */
    for (int prec = 15; prec <= 17; prec++) {
        snprintf(tmp, sizeof tmp, "%.*g", prec, v);
        if (strtod(tmp, NULL) == v) {
            break;
        }
    }
    buf_append_str(b, tmp);
}

const char *buf_cstr(buf_t *b)
{
    /* 防御：万一有人手动改过 len，也保证这里不越界。 */
    if (b->cap == 0) {
        return "";
    }
    if (b->len >= b->cap) {
        b->len = b->cap - 1;
    }
    b->data[b->len] = '\0';
    return (const char *)b->data;
}
