/**
 * http.h —— 极简 HTTP/1.1 请求解析与响应构造。
 *
 * 只实现这个项目真正用得到的部分：
 *   - 请求行：`GET /path HTTP/1.1`
 *   - 头部：只关心 Content-Length（判断请求体有多长）
 *   - 请求体：按 Content-Length 读，不支持 chunked
 *   - 响应：总是带 Content-Length，总是 `Connection: close`
 *
 * 刻意**不做**的事：chunked 编码、keep-alive 复用、HTTP/2、压缩协商。
 * 每加一项都要多一份状态机，而这里只有一个本地服务器、一台客户端。
 */
#ifndef R4K_HTTP_H
#define R4K_HTTP_H

#include <stddef.h>

#include "buf.h"

/** 请求路径的缓冲区长度。够放任何正常 URL。 */
#define HTTP_MAX_PATH 2048
#define HTTP_MAX_METHOD 16

typedef struct {
    char method[HTTP_MAX_METHOD];
    /** 已做 URL 解码、已去掉查询串的路径，例如 "/api/parse"。 */
    char path[HTTP_MAX_PATH];
    /** 查询串（不含 '?'）。没有则为空串。 */
    char query[HTTP_MAX_PATH];
    /** Content-Length 头；缺失时为 0。 */
    long long content_length;
} http_request;

/**
 * 解析请求头。
 *
 * @param data        已经收到的原始字节
 * @param len         字节数
 * @param req         输出
 * @param body_offset 输出：请求体在 data 里的起始偏移（即 "\r\n\r\n" 之后）
 * @return 0 成功；-1 表示头部还没收全或格式非法
 */
int http_parse_request(const char *data, size_t len, http_request *req, size_t *body_offset);

/** 追加响应状态行和公共头部。body_len 必须是即将发送的字节数。 */
void http_begin_response(buf_t *out, int status, const char *content_type,
                         unsigned long long body_len);

/** 构造一个纯文本错误响应（完整响应，可直接发送）。 */
void http_send_error(buf_t *out, int status, const char *message);

/** 状态码对应的原因短语。 */
const char *http_status_text(int status);

#endif /* R4K_HTTP_H */
