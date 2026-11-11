/**
 * main.c —— 程序入口与命令行参数。
 *
 * 两种模式：
 *   1. 服务器模式（默认）：`rhythm4k-server --root <目录> [--port 8080]`
 *   2. 解析模式（调试/对拍用）：`rhythm4k-server --parse <file.osu> [out.json]`
 *
 * 解析模式存在的意义：前端对拍测试需要拿**同一份输入**分别喂给 TS 解析器和
 * C 解析器，再逐字节比较输出。有了这个模式就不必为了测试去起一个 HTTP 服务。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "buf.h"
#include "common.h"
#include "osu.h"
#include "server.h"

#define VERSION "0.1.0"

static void print_usage(void)
{
    printf("rhythm-4k C backend %s\n", VERSION);
    printf("\n");
    printf("用法:\n");
    printf("  rhythm4k-server [选项]\n");
    printf("\n");
    printf("选项:\n");
    printf("  --root <目录>        静态文件根目录（默认 .）\n");
    printf("  --port <端口>        监听端口（默认 8080）\n");
    printf("  --port-tries <次数>  端口被占用时往后试几个（默认 10）\n");
    printf("  --quiet              不打印每条请求\n");
    printf("  --parse <file.osu> [out.json]  解析谱面并输出 JSON（不起服务）\n");
    printf("  --version            显示版本\n");
    printf("  --help               显示本帮助\n");
    printf("\n");
    printf("接口:\n");
    printf("  GET  /                静态文件（index.html 等）\n");
    printf("  GET  /api/health      健康检查\n");
    printf("  POST /api/parse       请求体是 .osu 文本，返回解析结果 JSON\n");
}

/** 读整个文件到 buf。失败返回 0。 */
static int read_file_into(const char *path, buf_t *out)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        return 0;
    }
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

/** `--parse` 分支。返回进程退出码。 */
static int run_parse_mode(const char *in_path, const char *out_path)
{
    buf_t input;
    buf_init(&input);

    if (!read_file_into(in_path, &input)) {
        fprintf(stderr, "cannot read file: %s\n", in_path);
        buf_free(&input);
        return 1;
    }

    char err[256];
    osu_beatmap *bm = osu_parse((const char *)input.data, input.len, err, sizeof err);
    buf_free(&input);

    if (bm == NULL) {
        fprintf(stderr, "parse failed: %s\n", err[0] != '\0' ? err : "unknown error");
        return 1;
    }

    buf_t json;
    buf_init(&json);
    osu_beatmap_to_json(&json, bm);
    osu_beatmap_free(bm);

    int code = 0;
    if (out_path != NULL) {
        FILE *f = fopen(out_path, "wb");
        if (f == NULL) {
            fprintf(stderr, "cannot write file: %s\n", out_path);
            code = 1;
        } else {
            fwrite(json.data, 1, json.len, f);
            fclose(f);
        }
    } else {
        fwrite(json.data, 1, json.len, stdout);
        fputc('\n', stdout);
    }

    buf_free(&json);
    return code;
}

int main(int argc, char **argv)
{
    const char *root = ".";
    int port = 8080;
    int port_tries = 10;
    int quiet = 0;
    const char *parse_in = NULL;
    const char *parse_out = NULL;

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];

        if (strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0) {
            print_usage();
            return 0;
        }
        if (strcmp(arg, "--version") == 0) {
            printf("%s\n", VERSION);
            return 0;
        }
        if (strcmp(arg, "--quiet") == 0 || strcmp(arg, "-q") == 0) {
            quiet = 1;
            continue;
        }
        if (strcmp(arg, "--root") == 0 && i + 1 < argc) {
            root = argv[++i];
            continue;
        }
        if (strcmp(arg, "--port") == 0 && i + 1 < argc) {
            port = atoi(argv[++i]);
            continue;
        }
        if (strcmp(arg, "--port-tries") == 0 && i + 1 < argc) {
            port_tries = atoi(argv[++i]);
            continue;
        }
        if (strcmp(arg, "--parse") == 0 && i + 1 < argc) {
            parse_in = argv[++i];
            /* 可选的第二个位置参数：输出文件 */
            if (i + 1 < argc && argv[i + 1][0] != '-') {
                parse_out = argv[++i];
            }
            continue;
        }

        fprintf(stderr, "unknown option: %s\n", arg);
        print_usage();
        return 2;
    }

    if (parse_in != NULL) {
        return run_parse_mode(parse_in, parse_out);
    }

    if (port < 1 || port > 65535) {
        fprintf(stderr, "invalid port: %d\n", port);
        return 2;
    }

    server_options opt;
    opt.root = root;
    opt.port = port;
    opt.port_tries = port_tries;
    opt.quiet = quiet;

    return server_run(&opt);
}
