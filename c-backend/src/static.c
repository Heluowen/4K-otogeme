#include "static.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "common.h"
#include "http.h"
#include "str.h"

/** 扩展名 → MIME 类型对照表。 */
typedef struct {
    const char *ext;
    const char *mime;
} mime_entry;

static const mime_entry MIME_TABLE[] = {
    {".html", "text/html; charset=utf-8"},
    {".htm", "text/html; charset=utf-8"},
    /* 注意这里：现代浏览器只认 text/javascript（application/javascript 也仍被接受，
     * 但 text/javascript 是 IANA 推荐值）。类型给错 = ES module 加载失败 = 白屏。 */
    {".js", "text/javascript; charset=utf-8"},
    {".mjs", "text/javascript; charset=utf-8"},
    {".css", "text/css; charset=utf-8"},
    {".json", "application/json; charset=utf-8"},
    {".map", "application/json; charset=utf-8"},
    {".txt", "text/plain; charset=utf-8"},
    {".svg", "image/svg+xml"},
    {".png", "image/png"},
    {".jpg", "image/jpeg"},
    {".jpeg", "image/jpeg"},
    {".gif", "image/gif"},
    {".webp", "image/webp"},
    {".ico", "image/x-icon"},
    {".woff", "font/woff"},
    {".woff2", "font/woff2"},
    {".osz", "application/octet-stream"},
    {".zip", "application/octet-stream"},
};

const char *mime_type_of(const char *path)
{
    if (path == NULL) {
        return "application/octet-stream";
    }

    const char *dot = strrchr(path, '.');
    if (dot != NULL) {
        for (size_t i = 0; i < sizeof MIME_TABLE / sizeof MIME_TABLE[0]; i++) {
            if (str_eq_ci(dot, MIME_TABLE[i].ext)) {
                return MIME_TABLE[i].mime;
            }
        }
    }
    return "application/octet-stream";
}

/**
 * 路径安全校验。
 *
 * 逐个路径段检查，只要出现 `..` 就拒绝。这样做比"先拼接再规范化"更不容易出错 ——
 * 那类实现经常在 `../` `..%2f` `....//` 这些变体上翻车。
 */
static int path_is_safe(const char *path)
{
    if (path == NULL) {
        return 0;
    }
    /* URL 里只该出现正斜杠。反斜杠在 Windows 上也是分隔符，
     * 放行它等于给路径穿越开了个后门。 */
    if (strchr(path, '\\') != NULL) {
        return 0;
    }

    const char *p = path;
    while (*p != '\0') {
        /* 跳过连续斜杠 */
        while (*p == '/') {
            p++;
        }
        const char *seg = p;
        while (*p != '\0' && *p != '/') {
            p++;
        }
        size_t len = (size_t)(p - seg);
        if (len == 2 && seg[0] == '.' && seg[1] == '.') {
            return 0;
        }
    }
    return 1;
}

/** 读整个文件到内存。失败返回 0。 */
static int read_whole_file(const char *path, buf_t *out)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        return 0;
    }

    /* 用 fseek/ftell 拿长度，然后一次性读。
     * 对小文件这是最简单的做法；超大文件才需要分块读。 */
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return 0;
    }
    long size = ftell(f);
    if (size < 0) {
        fclose(f);
        return 0;
    }
    if (fseek(f, 0, SEEK_SET) != 0) {
        fclose(f);
        return 0;
    }

    buf_clear(out);
    buf_reserve(out, (size_t)size);

    size_t got = fread(out->data, 1, (size_t)size, f);
    fclose(f);

    out->len = got;
    if (out->cap > 0) {
        out->data[out->len] = '\0';
    }
    return 1;
}

int static_serve(buf_t *out, const char *root, const char *path)
{
    if (!path_is_safe(path)) {
        http_send_error(out, 403, "403 Forbidden");
        return 403;
    }

    /* "/" 映射到 index.html */
    const char *rel = path;
    while (*rel == '/') {
        rel++;
    }
    if (*rel == '\0') {
        rel = "index.html";
    }

    /* 拼出磁盘路径。用 '/' 作分隔符，Windows 的 fopen 也认。 */
    buf_t full;
    buf_init(&full);
    buf_append_str(&full, root);
    if (full.len > 0 && full.data[full.len - 1] != '/') {
        buf_append_char(&full, '/');
    }
    buf_append_str(&full, rel);
    const char *full_path = buf_cstr(&full);

    buf_t file;
    buf_init(&file);
    if (!read_whole_file(full_path, &file)) {
        buf_free(&file);
        buf_free(&full);
        http_send_error(out, 404, "404 Not Found");
        return 404;
    }

    const char *mime = mime_type_of(rel);
    http_begin_response(out, 200, mime, (unsigned long long)file.len);
    buf_append(out, file.data, file.len);

    buf_free(&file);
    buf_free(&full);
    return 200;
}
