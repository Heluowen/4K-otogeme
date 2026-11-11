#include "common.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void fatal(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fputs("fatal: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(1);
}

void *xmalloc(size_t n)
{
    /* malloc(0) 的行为由实现定义，统一抬到 1，保证返回值总能安全 free。 */
    void *p = malloc(n == 0 ? 1 : n);
    if (p == NULL) {
        fatal("out of memory (%zu bytes)", n);
    }
    return p;
}

void *xcalloc(size_t count, size_t size)
{
    /* 溢出检查：count * size 若超过 SIZE_MAX，乘法会回绕成一个很小的值，
     * 于是「分配了一小块，却按大块去写」—— 这是经典的堆溢出漏洞。
     * 用除法判断而不是乘法，可以完全避开回绕。 */
    if (count != 0 && size > SIZE_MAX / count) {
        fatal("allocation overflow (%zu * %zu)", count, size);
    }
    void *p = calloc(count == 0 ? 1 : count, size == 0 ? 1 : size);
    if (p == NULL) {
        fatal("out of memory (%zu * %zu bytes)", count, size);
    }
    return p;
}

void *xrealloc(void *p, size_t n)
{
    void *q = realloc(p, n == 0 ? 1 : n);
    if (q == NULL) {
        fatal("out of memory growing to %zu bytes", n);
    }
    return q;
}

char *xstrdup(const char *s)
{
    size_t n = strlen(s);
    char *out = xmalloc(n + 1);
    memcpy(out, s, n + 1);
    return out;
}

char *xstrndup(const char *s, size_t n)
{
    size_t len = 0;
    /* 允许 s 不是以 '\0' 结尾的段落：先找实际长度，最多取 n 个字节。 */
    while (len < n && s[len] != '\0') {
        len++;
    }
    char *out = xmalloc(len + 1);
    memcpy(out, s, len);
    out[len] = '\0';
    return out;
}
