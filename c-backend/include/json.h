/**
 * json.h —— 手写 JSON 输出。
 *
 * 为什么自己写而不是引一个库：需要的功能只有"往 buf 里追加键值对"这一种，
 * 引库要处理链接和构建，自己写不到 100 行。
 *
 * 唯一需要小心的地方是**字符串转义** —— 曲名里出现一个引号或者换行，
 * 就能让整个 JSON 变成语法错误，前端 JSON.parse 直接抛异常。
 */
#ifndef R4K_JSON_H
#define R4K_JSON_H

#include <stdint.h>

#include "buf.h"

/**
 * 写出一个带引号的 JSON 字符串（含转义）。
 *
 * 处理规则（RFC 8259 要求）：
 *   "  →  \"          \  →  \\
 *   \n →  \n          \r →  \r          \t →  \t
 *   其它 < 0x20 的控制字符 → \u00XX
 *   >= 0x80 的字节原样输出（JSON 文档本身是 UTF-8，直接写就行）
 */
void json_write_string(buf_t *b, const char *s);

void json_kv_string(buf_t *b, const char *key, const char *value);
void json_kv_i64(buf_t *b, const char *key, int64_t value);
void json_kv_double(buf_t *b, const char *key, double value);
void json_kv_bool(buf_t *b, const char *key, int value);

#endif /* R4K_JSON_H */
