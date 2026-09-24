# 接口描述来源

- `agentmail-openapi-1.5.0.json`：未修改的官方 `agentmail-cli@1.5.0 --spec-raw` 输出，对应上游提交 `43ec9bfa1fc4c2641e80815e5c99246089b9ea8f` 的 `cli/agentmail/openapi0.json`，包含 140 个操作。SHA-256 为 `091ff0ff81360af1e248e03d49272e038f36e0cd2932067ce28fa512fdeeb6ce`。
- `agentmail-cli-discovery-1.5.0.json`：同版本官方 CLI 的命令发现快照，用于参数/响应描述和对照测试。
- `grove-mail-api.json`：从 Grove 服务 `16ee2ef` 的 `src/protocol.ts` 导出的公开请求描述，包含 Grove 的短命令和扩展；不包含服务器实现、配置或凭据。

前两项来源为 https://github.com/agentmail-to/agentmail-cli 。接口描述不代表我们拥有 AgentMail 服务端源码，也不代表其托管服务的全部行为已对照。保留上游归属，不改变快照字节来伪造兼容结果。

更新 Grove 接口时，在服务仓库执行 `node --import tsx scripts/export-cli-schema.ts /path/to/grove-mail-cli/docs/reference/grove-mail-api.json`，随后在客户端仓库运行测试并提交接口快照。
