#include "json.h"

#include <string.h>

#include "common.h"

void json_write_string(buf_t *b, const char *s)
{
    buf_append_char(b, '"');

    if (s != NULL) {
        /* 按 unsigned char 遍历：signed char 在遇到 >= 0x80 的字节时会是负数，
         * 比较 '< 0x20' 会误判。UTF-8 的多字节序列全部 >= 0x80，必须原样透传。 */
        for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; p++) {
            unsigned char c = *p;
            switch (c) {
            case '"':
                buf_append_str(b, "\\\"");
                break;
            case '\\':
                buf_append_str(b, "\\\\");
                break;
            case '\n':
                buf_append_str(b, "\\n");
                break;
            case '\r':
                buf_append_str(b, "\\r");
                break;
            case '\t':
                buf_append_str(b, "\\t");
                break;
            case '\b':
                buf_append_str(b, "\\b");
                break;
            case '\f':
                buf_append_str(b, "\\f");
                break;
            default:
                if (c < 0x20) {
                    /* 其它控制字符没有短写法，只能用 \u00XX。 */
                    buf_appendf(b, "\\u%04x", (unsigned)c);
                } else {
                    buf_append_u8(b, c);
                }
                break;
            }
        }
    }

    buf_append_char(b, '"');
}

void json_kv_string(buf_t *b, const char *key, const char *value)
{
    json_write_string(b, key);
    buf_append_char(b, ':');
    /* 缺失的字符串统一写成 ""，避免前端拿到 null 还要到处判空。 */
    json_write_string(b, value == NULL ? "" : value);
}

void json_kv_i64(buf_t *b, const char *key, int64_t value)
{
    json_write_string(b, key);
    buf_append_char(b, ':');
    buf_append_i64(b, value);
}

void json_kv_double(buf_t *b, const char *key, double value)
{
    json_write_string(b, key);
    buf_append_char(b, ':');
    buf_append_double(b, value);
}

void json_kv_bool(buf_t *b, const char *key, int value)
{
    json_write_string(b, key);
    buf_append_char(b, ':');
    buf_append_str(b, value ? "true" : "false");
}
