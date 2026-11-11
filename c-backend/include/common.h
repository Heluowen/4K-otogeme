/**
 * common.h —— 全工程共用的基础定义。
 *
 * ============================ 错误处理策略 ============================
 *
 * 本工程对「内存分配失败」采取**终止进程**的策略，而不是让每个调用点都去检查 NULL。
 *
 * 理由：
 *   1. 这是一个本地小服务器，单次响应最大也就几 MB。真的 OOM 说明系统已经不对劲了，
 *      继续运行只会输出更莫名其妙的结果。
 *   2. C 没有异常，错误码会沿着每条调用链传染。如果 xmalloc 可能返回 NULL，
 *      那么 buf_append、json_kv_str、osu_parse… 全都要改成返回错误码，
 *      每个调用点都要写 if。这些噪声会淹没真正的业务逻辑。
 *
 * 这是工程权衡，不是偷懒。真要做「可恢复」的分配，得换一套 arena 或者
 * 把错误码贯穿到底 —— 那已经不是这份代码的目标了。
 */
#ifndef R4K_COMMON_H
#define R4K_COMMON_H

#include <stddef.h>
#include <stdint.h>

/** 分配内存；失败时打印原因并 exit(1)，永不返回 NULL。 */
void *xmalloc(size_t n);

/** 分配并清零；count * size 溢出会直接报错（防止整数回绕导致的堆溢出）。 */
void *xcalloc(size_t count, size_t size);

/** 调整大小；p 为 NULL 时等价于 xmalloc。 */
void *xrealloc(void *p, size_t n);

/** 复制一个以 '\0' 结尾的字符串。 */
char *xstrdup(const char *s);

/** 复制前 n 个字节并补 '\0'。用于从原文里切出字段，不修改源缓冲区。 */
char *xstrndup(const char *s, size_t n);

/** 打印错误并退出。 */
void fatal(const char *fmt, ...);

/** 显式标记「这个参数我故意没用」，避免 -Wunused-parameter 噪声。 */
#define R4K_UNUSED(x) ((void)(x))

#endif /* R4K_COMMON_H */
