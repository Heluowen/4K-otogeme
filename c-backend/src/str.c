#include "str.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

/** 判断是否是「空白字符」。显式列出，避免 isspace 受 locale 影响。 */
static int is_space_ch(char c)
{
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v';
}

char *str_trim_inplace(char *s)
{
    if (s == NULL) {
        return NULL;
    }

    /* 先跳过前导空白，得到真正的起点。 */
    char *start = s;
    while (is_space_ch(*start)) {
        start++;
    }

    /* 再从结尾往回找最后一个非空白。
     * 从 '\0' 前一位开始扫，比先 strlen 再往回扫少走一遍。 */
    char *end = start;
    while (*end != '\0') {
        end++;
    }
    while (end > start && is_space_ch(end[-1])) {
        end--;
    }

    /* 关键一步：把结尾标成 '\0'。注意要写 end 而不是 end-1。 */
    *end = '\0';
    return start;
}

int str_starts_with(const char *s, const char *prefix)
{
    if (s == NULL || prefix == NULL) {
        return 0;
    }
    size_t n = strlen(prefix);
    return strncmp(s, prefix, n) == 0;
}

static int to_lower_ch(int c)
{
    if (c >= 'A' && c <= 'Z') {
        return c - 'A' + 'a';
    }
    return c;
}

int str_ends_with_ci(const char *s, const char *suffix)
{
    if (s == NULL || suffix == NULL) {
        return 0;
    }
    size_t n = strlen(s);
    size_t m = strlen(suffix);
    if (m > n) {
        return 0;
    }
    const char *p = s + (n - m);
    for (size_t i = 0; i < m; i++) {
        if (to_lower_ch((unsigned char)p[i]) != to_lower_ch((unsigned char)suffix[i])) {
            return 0;
        }
    }
    return 1;
}

int str_eq_ci(const char *a, const char *b)
{
    if (a == NULL) {
        a = "";
    }
    if (b == NULL) {
        b = "";
    }
    while (*a != '\0' && *b != '\0') {
        if (to_lower_ch((unsigned char)*a) != to_lower_ch((unsigned char)*b)) {
            return 0;
        }
        a++;
        b++;
    }
    return *a == '\0' && *b == '\0';
}

void str_lower_inplace(char *s)
{
    if (s == NULL) {
        return;
    }
    for (char *p = s; *p != '\0'; p++) {
        *p = (char)to_lower_ch((unsigned char)*p);
    }
}

int str_split(char *line, char sep, char **fields, int max)
{
    if (line == NULL || fields == NULL || max <= 0) {
        return 0;
    }

    int count = 0;
    fields[count++] = line;

    for (char *p = line; *p != '\0'; p++) {
        if (*p == sep) {
            if (count >= max) {
                /* 字段数超过上限：就地截断。
                 * 对 osu 来说多出来的字段都是我们不关心的，静默忽略即可。 */
                break;
            }
            *p = '\0';
            fields[count++] = p + 1;
        }
    }

    return count;
}

int str_parse_double(const char *s, double *out)
{
    if (s == NULL) {
        if (out != NULL) {
            *out = 0.0;
        }
        return 1;
    }

    /* strtod 自己会跳过前导空白，所以这里不用手工 skip。 */
    char *end = NULL;
    double v = strtod(s, &end);

    /* end == s 表示一个字符都没吃到 —— 不是数字。
     * 但空串/全空白时 JS 的 Number 返回 0，要单独照顾。 */
    if (end == s) {
        for (const char *p = s; *p != '\0'; p++) {
            if (!is_space_ch(*p)) {
                return 0; /* 有非空白字符却解析不出来 → NaN */
            }
        }
        if (out != NULL) {
            *out = 0.0;
        }
        return 1;
    }

    /* 检查尾部：只允许空白。
     * 这一条是「严格」的关键 —— '12abc' 必须判失败，而不是当成 12。 */
    for (const char *p = end; *p != '\0'; p++) {
        if (!is_space_ch(*p)) {
            return 0;
        }
    }

    if (out != NULL) {
        *out = v;
    }
    return 1;
}

int str_parse_i64(const char *s, long long *out)
{
    double v = 0.0;
    if (!str_parse_double(s, &v)) {
        return 0;
    }
    /* 截断向零取整（和 JS 的 Math.trunc 一致；Math.round 由调用方另行处理）。 */
    if (out != NULL) {
        *out = (long long)v;
    }
    return 1;
}
