/**
 * str.h —— 字符串工具。
 *
 * C 的字符串处理是这个语言最容易出事故的地方：没有长度信息、没有边界检查、
 * 一个 '\0' 写错位置就是未定义行为。这里的函数都遵循两条规矩：
 *
 *   1. **不分配新内存的就不分配**（改原地的显式叫 _inplace / 破坏性）
 *   2. **需要写出长度的地方一律带 max**，绝不假设调用方缓冲区够大
 */
#ifndef R4K_STR_H
#define R4K_STR_H

#include <stddef.h>

/**
 * 去掉首尾空白（空格、\t、\r、\n、\f、\v），原地修改。
 *
 * @return 指向第一个非空白字符的指针。可能等于 s（没有前导空白时）。
 *         注意返回值可能不是 s 的起始位置，所以要拿返回值而不是 s。
 */
char *str_trim_inplace(char *s);

/** s 是否以 prefix 开头。NULL 安全。 */
int str_starts_with(const char *s, const char *prefix);

/** s 是否以 suffix 结尾（忽略大小写）。用于判断 ".osu" 后缀。 */
int str_ends_with_ci(const char *s, const char *suffix);

/** 忽略大小写比较两个字符串。NULL 视为空串。 */
int str_eq_ci(const char *a, const char *b);

/** 转小写，原地修改。 */
void str_lower_inplace(char *s);

/**
 * 按分隔符切分（**破坏性**：把分隔符原位改成 '\0'）。
 *
 * 这是 C 里处理表格式文本最快的做法：不复制任何字节，只把逗号变成字符串结尾。
 * 代价是原始行被改写，所以调用方必须持有一份可写的副本。
 *
 * @param line   可写的行内容
 * @param sep    分隔符（osu 用逗号）
 * @param fields 输出数组
 * @param max    最多写多少个字段（防止越界）
 * @return 实际写出的字段数（不会超过 max）
 */
int str_split(char *line, char sep, char **fields, int max);

/**
 * 严格解析一个浮点数，行为对齐 JavaScript 的 `Number(str)`。
 *
 * 与裸 strtod 的区别：
 *   - 允许任意前后空白（`Number(' 12 ')` 是 12）
 *   - **不允许尾部残留**（`Number('12abc')` 是 NaN，而 strtod 会解析出 12）
 *   - 空串或全空白 → 0（`Number('')` 是 0）
 *
 * @return 1 表示解析成功，0 表示这不是一个数字（对应 TS 的 NaN）
 */
int str_parse_double(const char *s, double *out);

/** 解析 64 位整数。规则同上。成功返回 1。 */
int str_parse_i64(const char *s, long long *out);

#endif /* R4K_STR_H */
