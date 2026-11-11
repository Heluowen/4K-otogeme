#include "http.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "common.h"
#include "str.h"

const char *http_status_text(int status)
{
    switch (status) {
    case 200:
        return "OK";
    case 204:
        return "No Content";
    case 400:
        return "Bad Request";
    case 403:
        return "Forbidden";
    case 404:
        return "Not Found";
    case 405:
        return "Method Not Allowed";
    case 413:
        return "Payload Too Large";
    case 500:
        return "Internal Server Error";
    default:
        return "Unknown";
    }
}

/** 十六进制字符转数值；非法返回 -1。 */
static int hex_digit(int c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

/**
 * URL 解码（就地把 %XX 变成原字节）。
 *
 * 浏览器会把路径里的非 ASCII（比如中文文件名）先百分号编码再发过来，
 * 不解码就找不到文件。
 */
static void url_decode_inplace(char *s)
{
    char *out = s;
    for (char *p = s; *p != '\0'; p++) {
        if (*p == '%' && p[1] != '\0' && p[2] != '\0') {
            int hi = hex_digit((unsigned char)p[1]);
            int lo = hex_digit((unsigned char)p[2]);
            if (hi >= 0 && lo >= 0) {
                *out++ = (char)((hi << 4) | lo);
                p += 2;
                continue;
            }
        }
        *out++ = *p;
    }
    *out = '\0';
}

/** 从 [start, end) 里截出一个「不区分大小写的键」，用于匹配头部字段名。 */
static int header_name_is(const char *line, size_t name_len, const char *want)
{
    size_t want_len = strlen(want);
    if (name_len != want_len) {
        return 0;
    }
    for (size_t i = 0; i < want_len; i++) {
        if (tolower((unsigned char)line[i]) != tolower((unsigned char)want[i])) {
            return 0;
        }
    }
    return 1;
}

int http_parse_request(const char *data, size_t len, http_request *req, size_t *body_offset)
{
    if (req == NULL || data == NULL) {
        return -1;
    }
    req->method[0] = '\0';
    req->path[0] = '\0';
    req->query[0] = '\0';
    req->content_length = 0;

    /* ── 1. 找请求头的结尾 ──
     * 标准写法是 "\r\n\r\n"，但有些简陋的客户端只发 "\n\n"，两种都接受。 */
    size_t header_end = (size_t)-1;
    size_t body_start = 0;
    for (size_t i = 0; i + 3 < len; i++) {
        if (data[i] == '\r' && data[i + 1] == '\n' && data[i + 2] == '\r' && data[i + 3] == '\n') {
            header_end = i;
            body_start = i + 4;
            break;
        }
    }
    if (header_end == (size_t)-1) {
        for (size_t i = 0; i + 1 < len; i++) {
            if (data[i] == '\n' && data[i + 1] == '\n') {
                header_end = i;
                body_start = i + 2;
                break;
            }
        }
    }
    if (header_end == (size_t)-1) {
        return -1; /* 头部还没收全 */
    }

    if (body_offset != NULL) {
        *body_offset = body_start;
    }

    /* ── 2. 逐行扫描头部 ── */
    size_t pos = 0;
    int first_line = 1;

    while (pos < header_end) {
        size_t line_start = pos;
        while (pos < header_end && data[pos] != '\n') {
            pos++;
        }
        size_t line_end = pos;
        if (pos < header_end) {
            pos++; /* 跳过 '\n' */
        }
        /* 去掉行尾的 '\r' */
        if (line_end > line_start && data[line_end - 1] == '\r') {
            line_end--;
        }
        if (line_end == line_start) {
            continue; /* 空行 */
        }

        if (first_line) {
            first_line = 0;

            /* 请求行：METHOD SP PATH SP VERSION */
            const char *sp1 = memchr(data + line_start, ' ', line_end - line_start);
            if (sp1 == NULL) {
                return -1;
            }
            size_t method_len = (size_t)(sp1 - (data + line_start));
            if (method_len == 0 || method_len >= HTTP_MAX_METHOD) {
                return -1;
            }
            memcpy(req->method, data + line_start, method_len);
            req->method[method_len] = '\0';

            const char *path_start = sp1 + 1;
            const char *rest_end = data + line_end;
            const char *sp2 = memchr(path_start, ' ', (size_t)(rest_end - path_start));

            size_t path_len;
            if (sp2 == NULL) {
                /* HTTP/1.0 早期写法允许省略版本号 */
                path_len = (size_t)(rest_end - path_start);
            } else {
                path_len = (size_t)(sp2 - path_start);
            }

            if (path_len == 0 || path_len >= HTTP_MAX_PATH) {
                return -1;
            }

            memcpy(req->path, path_start, path_len);
            req->path[path_len] = '\0';

            /* 把查询串切出去，只留纯路径 */
            char *qm = strchr(req->path, '?');
            if (qm != NULL) {
                snprintf(req->query, sizeof req->query, "%s", qm + 1);
                *qm = '\0';
            }

            url_decode_inplace(req->path);
            continue;
        }

        /* 普通头部行：`Name: Value` */
        const char *colon = memchr(data + line_start, ':', line_end - line_start);
        if (colon == NULL) {
            continue;
        }
        size_t name_len = (size_t)(colon - (data + line_start));

        if (header_name_is(data + line_start, name_len, "Content-Length")) {
            const char *v = colon + 1;
            const char *v_end = data + line_end;
            while (v < v_end && (*v == ' ' || *v == '\t')) {
                v++;
            }
            char tmp[32];
            size_t n = (size_t)(v_end - v);
            if (n >= sizeof tmp) {
                n = sizeof tmp - 1;
            }
            memcpy(tmp, v, n);
            tmp[n] = '\0';

            long long parsed = 0;
            if (str_parse_i64(tmp, &parsed) && parsed >= 0) {
                req->content_length = parsed;
            }
        }
    }

    if (req->method[0] == '\0') {
        return -1;
    }
    return 0;
}

void http_begin_response(buf_t *out, int status, const char *content_type,
                         unsigned long long body_len)
{
    buf_appendf(out, "HTTP/1.1 %d %s\r\n", status, http_status_text(status));
    if (content_type != NULL) {
        buf_appendf(out, "Content-Type: %s\r\n", content_type);
    }

    /* 这几个 CORS 头是为了开发时前后端分离：
     * Vite dev server 跑在 5173，C 后端跑在 8080，属于跨源请求，
     * 浏览器默认会拦掉。生产环境下两者同源，这些头无害。 */
    buf_append_str(out, "Access-Control-Allow-Origin: *\r\n");
    buf_append_str(out, "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
    buf_append_str(out, "Access-Control-Allow-Headers: Content-Type\r\n");

    buf_append_str(out, "Cache-Control: no-store\r\n");
    /* 永远关闭连接：省掉 keep-alive 状态机，也让浏览器不会占着连接不放。 */
    buf_append_str(out, "Connection: close\r\n");

    buf_appendf(out, "Content-Length: %llu\r\n", body_len);
    buf_append_str(out, "\r\n");
}

void http_send_error(buf_t *out, int status, const char *message)
{
    buf_t body;
    buf_init(&body);
    buf_append_str(&body, message == NULL ? http_status_text(status) : message);

    http_begin_response(out, status, "text/plain; charset=utf-8", (unsigned long long)body.len);
    buf_append(out, body.data, body.len);
    buf_free(&body);
}
