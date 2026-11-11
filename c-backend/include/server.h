/**
 * server.h —— HTTP 服务器。
 *
 * 并发模型：**单线程 + select()**。
 *
 * 理由：客户端只有一个（本机浏览器），请求量是每秒个位数。
 * 为这个场景上线程池只会引入锁、竞态和更难调试的崩溃。
 * 而 select 的"事件循环"模型和 Node 是同一个思路 —— 恰好也方便对照阅读
 * 原来的 `tools/serve-static.mjs`。
 *
 * 已知取舍：连接是**同步处理**的（读完 → 处理 → 写回 → 关闭）。
 * 一个极慢的客户端会短暂占住主循环，靠 SO_RCVTIMEO / SO_SNDTIMEO 兜底。
 * 对本机自娱自乐够用；要扛公网流量得换成每连接一线程或 IOCP。
 *
 * 平台：Windows（Winsock2）。移植到 Linux 只需要把 socket 相关的
 * 类型和初始化换成 POSIX 的（socket / bind / listen 的用法基本一样）。
 */
#ifndef R4K_SERVER_H
#define R4K_SERVER_H

typedef struct {
    /** 静态文件根目录（相对或绝对路径都行）。 */
    const char *root;
    /** 监听的起始端口。 */
    int port;
    /** 端口被占用时最多往后试几个。 */
    int port_tries;
    /** 1 = 不打印每条请求（只打印启动信息）。 */
    int quiet;
} server_options;

/** 启动服务器并阻塞运行。返回 0 表示正常退出，非 0 表示出错。 */
int server_run(const server_options *opt);

#endif /* R4K_SERVER_H */
