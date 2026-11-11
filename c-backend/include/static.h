/**
 * static.h —— 静态文件服务。
 *
 * 两件必须做对的事：
 *   1. **MIME 类型**。`index.js` 如果被当成 `application/octet-stream` 返回，
 *      浏览器会拒绝把它当模块执行 —— 这是最常见的「白屏」原因之一。
 *   2. **路径穿越防护**。`GET /../../Windows/win.ini` 必须被挡掉。
 *      URL 解码在前，所以 `%2e%2e/` 会先变成 `../`，检查必须放在解码之后。
 */
#ifndef R4K_STATIC_H
#define R4K_STATIC_H

#include "buf.h"

/** 根据扩展名推断 Content-Type。未知扩展名返回 application/octet-stream。 */
const char *mime_type_of(const char *path);

/**
 * 把一个文件组装成**完整**的 HTTP 响应（状态行 + 头 + 体）写进 out。
 *
 * @param root 文档根目录，例如 "dist"
 * @param path 请求路径，例如 "/assets/index-abc.js"
 * @return HTTP 状态码（200 / 403 / 404）
 */
int static_serve(buf_t *out, const char *root, const char *path);

#endif /* R4K_STATIC_H */
