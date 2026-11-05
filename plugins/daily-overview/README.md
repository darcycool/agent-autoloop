# 每日处理记录

独立的本机只读客户端。原生 HTML、CSS、JavaScript 和 Node.js 24 内置模块，无构建步骤或运行时依赖，不导入中台内核。

在有本人配置的电脑运行：

```sh
agent-autoloop overview
```

源码目录可运行 `node plugins/daily-overview/run.ts`。`--no-open` 只打印浏览器入口，`--port 3360` 指定本机端口。Ctrl+C 退出，不影响中台。

- `run.ts`：配置、启动、浏览器入口和退出。
- `feed.ts`：现有本人 HTTP 查询、事实流接续和私有可重建缓存。
- `model.ts`：客户端归并、日终重放和耗时计算。
- `server.ts`：本机访问校验、静态文件和只读查询。
- `public/`：日期、筛选、列表和并读详情。

配置默认在 `~/.agent-autoloop/config.json`，缓存默认在 `~/.agent-autoloop/cache/daily-overview/`，均随 `AGENT_AUTOLOOP_HOME` 切换。仅向配置中的中台发 GET 请求，不提供修改或代理入口；本人密钥不进入浏览器。缓存含私有业务资料，不要分享。

首版不展示用量。回执摘要不是完整会话，执行结束不是业务验收，历史同步也不能假装完整。详细[计算口径与限制](../../docs/daily-overview.md)。
