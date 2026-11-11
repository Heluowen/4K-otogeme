/**
 * server.c —— Winsock2 上的单线程 HTTP 服务器。
 *
 * ⚠️ 注意头文件的顺序：winsock2.h 必须在 windows.h 之前引入，
 *    否则会拿到一堆 winsock1 的旧定义。本文件干脆完全不引 windows.h。
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "buf.h"
#include "common.h"
#include "http.h"
#include "osu.h"
#include "server.h"
#include "static.h"

/* 请求头上限 64KB：正常头部只有几百字节，给到这个量级足够防呆。 */
#define MAX_HEADER_BYTES (64 * 1024)
/* 请求体上限 32MB。.osu 文件通常几十 KB 到 1MB，32MB 是安全的天花板。 */
#define MAX_BODY_BYTES (32 * 1024 * 1024)
/* 单次 recv 的读块大小。 */
#define READ_CHUNK 8192

/**
 * 一次性读完一个完整的 HTTP 请求。
 *
 * 两阶段：先把头部读完（才能知道 Content-Length），再按长度把体读完。
 * 不能假设"一次 recv 就是一个完整请求" —— TCP 是字节流，没有消息边界，
 * 分片和粘包都是常态。
 */
static int read_full_request(SOCKET s, buf_t *out, http_request *req, size_t *body_offset)
{
    char chunk[READ_CHUNK];
    int parsed = 0;
    long long body_len = 0;

    for (;;) {
        if (out->len > MAX_HEADER_BYTES + (size_t)MAX_BODY_BYTES) {
            return 0;
        }

        int n = recv(s, chunk, (int)sizeof chunk, 0);
        if (n <= 0) {
            /* 0 = 对端正常关闭；< 0 = 出错或超时。
             * 有一种合法情况：客户端发完请求就半关闭写端，我们已经收全了。 */
            if (parsed && (long long)(out->len - *body_offset) >= body_len) {
                return 1;
            }
            return 0;
        }

        buf_append(out, chunk, (size_t)n);

        if (!parsed) {
            if (http_parse_request((const char *)out->data, out->len, req, body_offset) == 0) {
                parsed = 1;
                body_len = req->content_length;
                if (body_len < 0 || body_len > MAX_BODY_BYTES) {
                    return 0;
                }
            } else if (out->len > MAX_HEADER_BYTES) {
                return 0; /* 头部大到不合理，多半是垃圾数据 */
            }
        }

        if (parsed && (long long)(out->len - *body_offset) >= body_len) {
            return 1;
        }
    }
}

/** 把 buf 全部发出去。send 可能只写一部分，必须循环。 */
static int send_all(SOCKET s, const char *data, size_t len)
{
    size_t sent = 0;
    while (sent < len) {
        size_t remain = len - sent;
        int chunk = (remain > 65536) ? 65536 : (int)remain;
        int n = send(s, data + sent, chunk, 0);
        if (n <= 0) {
            return 0;
        }
        sent += (size_t)n;
    }
    return 1;
}

/* ===========================================================================
 * 路由
 * ========================================================================= */

/** `GET /api/health` */
static void handle_health(buf_t *resp)
{
    buf_t body;
    buf_init(&body);
    buf_append_str(&body,
                   "{\"ok\":true,\"service\":\"rhythm-4k-c-backend\","
                   "\"version\":\"0.1.0\",\"features\":[\"osu-parse\",\"static\"]}");

    http_begin_response(resp, 200, "application/json; charset=utf-8",
                        (unsigned long long)body.len);
    buf_append(resp, body.data, body.len);
    buf_free(&body);
}

/**
 * `POST /api/parse` —— 请求体是 `.osu` 文件的文本，响应是解析结果的 JSON。
 *
 * 这一层刻意不做"解压"：`.osz` 的解压留在前端（浏览器自带 DecompressionStream）。
 * 于是 C 端只需要处理纯文本，不必自己实现 DEFLATE —— 那会是另一个量级的代码量。
 */
static void handle_parse(buf_t *resp, const char *body, size_t body_len)
{
    char err[256];
    osu_beatmap *bm = osu_parse(body, body_len, err, sizeof err);

    if (bm == NULL) {
        buf_t out;
        buf_init(&out);
        buf_append_str(&out, "{\"ok\":false,\"error\":");
        buf_append_char(&out, '"');
        /* 错误信息里可能有引号/反斜杠，交给 json 模块转义 */
        {
            buf_t esc;
            buf_init(&esc);
            /* 复用 json_write_string 的转义能力：先写一个完整字符串再裁掉首尾引号 */
            extern void json_write_string(buf_t *, const char *);
            json_write_string(&esc, err[0] != '\0' ? err : "parse failed");
            buf_append(&out, esc.data + 1, esc.len - 2);
            buf_free(&esc);
        }
        buf_append_char(&out, '"');
        buf_append_char(&out, '}');

        http_begin_response(resp, 400, "application/json; charset=utf-8",
                            (unsigned long long)out.len);
        buf_append(resp, out.data, out.len);
        buf_free(&out);
        return;
    }

    buf_t out;
    buf_init(&out);
    osu_beatmap_to_json(&out, bm);

    http_begin_response(resp, 200, "application/json; charset=utf-8",
                        (unsigned long long)out.len);
    buf_append(resp, out.data, out.len);

    buf_free(&out);
    osu_beatmap_free(bm);
}

/** 分发请求。 */
static void route(const char *root, const http_request *req, const char *body,
                  size_t body_len, int head_only, buf_t *resp)
{
    /* 预检请求：浏览器在跨源 POST 之前会先发一个 OPTIONS */
    if (strcmp(req->method, "OPTIONS") == 0) {
        http_begin_response(resp, 204, NULL, 0);
        return;
    }

    if (strcmp(req->path, "/api/health") == 0) {
        if (strcmp(req->method, "GET") != 0 && strcmp(req->method, "HEAD") != 0) {
            http_send_error(resp, 405, "405 Method Not Allowed");
            return;
        }
        handle_health(resp);
        return;
    }

    if (strcmp(req->path, "/api/parse") == 0) {
        if (strcmp(req->method, "POST") != 0) {
            http_send_error(resp, 405, "405 Method Not Allowed: use POST");
            return;
        }
        handle_parse(resp, body, body_len);
        return;
    }

    if (strcmp(req->method, "GET") != 0 && strcmp(req->method, "HEAD") != 0) {
        http_send_error(resp, 405, "405 Method Not Allowed");
        return;
    }

    static_serve(resp, root, req->path);

    /* HEAD 只回头部，不回体。
     * 响应头里的 Content-Length 仍然是 GET 会返回的长度 —— 这正是 HTTP 的规定。 */
    if (head_only) {
        buf_t *b = resp;
        for (size_t i = 0; i + 3 < b->len; i++) {
            if (b->data[i] == '\r' && b->data[i + 1] == '\n' && b->data[i + 2] == '\r' &&
                b->data[i + 3] == '\n') {
                b->len = i + 4;
                b->data[b->len] = '\0';
                break;
            }
        }
    }
}

/* ===========================================================================
 * 单连接处理
 * ========================================================================= */

static void handle_connection(SOCKET client, const char *root, int quiet)
{
    /* 超时兜底：一个连上来什么都不发的客户端，不能让主循环永远卡住。 */
    DWORD timeout = 5000;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof timeout);
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout, sizeof timeout);

    buf_t request;
    buf_init(&request);

    http_request req;
    size_t body_offset = 0;

    buf_t response;
    buf_init(&response);

    if (!read_full_request(client, &request, &req, &body_offset)) {
        http_send_error(&response, 400, "400 Bad Request");
        send_all(client, (const char *)response.data, response.len);
        goto done;
    }

    {
        const char *body = (const char *)request.data + body_offset;
        size_t body_len = request.len - body_offset;
        int head_only = (strcmp(req.method, "HEAD") == 0);

        route(root, &req, body, body_len, head_only, &response);
        send_all(client, (const char *)response.data, response.len);

        if (!quiet) {
            /* 从响应里把状态码抠出来，省得每个 handler 都往下传一遍。 */
            int status = 0;
            if (response.len > 12) {
                char tmp[4] = {0};
                memcpy(tmp, response.data + 9, 3);
                status = atoi(tmp);
            }
            printf("  %-4s %-40s %d\n", req.method, req.path, status);
            fflush(stdout);
        }
    }

done:
    buf_free(&request);
    buf_free(&response);
    closesocket(client);
}

/* ===========================================================================
 * 主循环
 * ========================================================================= */

int server_run(const server_options *opt)
{
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "WSAStartup failed\n");
        return 1;
    }

    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) {
        fprintf(stderr, "socket() failed: %d\n", WSAGetLastError());
        WSACleanup();
        return 1;
    }

    /* 允许复用 TIME_WAIT 状态的地址，否则重启服务器要等几十秒。 */
    int yes = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof yes);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    /* 只绑回环地址：这是本机自娱自乐的工具，不该对外网暴露。 */
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    int bound_port = 0;
    for (int i = 0; i < (opt->port_tries > 0 ? opt->port_tries : 1); i++) {
        addr.sin_port = htons((u_short)(opt->port + i));
        if (bind(listener, (struct sockaddr *)&addr, sizeof addr) == 0) {
            bound_port = opt->port + i;
            break;
        }
    }

    if (bound_port == 0) {
        fprintf(stderr, "bind failed: ports %d..%d all in use\n", opt->port,
                opt->port + opt->port_tries - 1);
        closesocket(listener);
        WSACleanup();
        return 1;
    }

    if (listen(listener, 16) != 0) {
        fprintf(stderr, "listen() failed: %d\n", WSAGetLastError());
        closesocket(listener);
        WSACleanup();
        return 1;
    }

    printf("\n");
    printf("  rhythm-4k C backend is running\n");
    printf("\n");
    printf("    http://127.0.0.1:%d/\n", bound_port);
    printf("\n");
    printf("  Serving: %s\n", opt->root);
    printf("  API:     POST /api/parse   GET /api/health\n");
    printf("  Close this window to stop.\n");
    printf("\n");
    fflush(stdout);

    for (;;) {
        fd_set readfds;
        FD_ZERO(&readfds);
        FD_SET(listener, &readfds);

        /* 第一个参数在 Windows 上被忽略，传 0 即可。 */
        int ready = select(0, &readfds, NULL, NULL, NULL);
        if (ready == SOCKET_ERROR) {
            fprintf(stderr, "select() failed: %d\n", WSAGetLastError());
            break;
        }
        if (ready == 0) {
            continue;
        }

        if (FD_ISSET(listener, &readfds)) {
            SOCKET client = accept(listener, NULL, NULL);
            if (client == INVALID_SOCKET) {
                continue;
            }
            handle_connection(client, opt->root, opt->quiet);
        }
    }

    closesocket(listener);
    WSACleanup();
    return 0;
}
