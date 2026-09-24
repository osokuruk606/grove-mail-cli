# 使用 Grove Mail CLI

## 身份和服务地址

`grove-mail auth login` 保存 API key，`auth status` 检查本机配置，`auth logout` 删除本机已保存凭据。`auth status` 不会验证服务器权限；运行 `inboxes list` 才会实际连接服务器。

默认配置文件是 `~/.config/grove-mail/config.json`。用 `GROVE_MAIL_CLIENT_CONFIG` 指定另一身份的配置文件；整个注册、登录、验证和后续操作应使用同一配置文件。`GROVE_MAIL_API_KEY` 环境变量优先于文件中的 key。网页邮箱使用独立的邮箱密码。

```sh
grove-mail auth login --base-url https://mail.example.com/agent
grove-mail inboxes list
```

## 发现和操作

```sh
grove-mail --help
grove-mail inboxes messages --help
grove-mail inboxes drafts create --schema
grove-mail messages list --inbox bot@example.com --limit 20
grove-mail messages send --inbox bot@example.com --to receiver@example.com \
  --subject 测试 --text-file body.txt --idempotency-key task-001
grove-mail messages watch --inbox bot@example.com --cursor-file mail.cursor
grove-mail messages raw --inbox bot@example.com --message msg_example --output original.eml
```

服务端决定账号可用能力及权限。CLI 的命令目录覆盖固定 AgentMail 1.5.0 合同和 Grove 扩展，不表示其他服务可以接受全部扩展。

管道默认输出 JSON，交互终端默认表格。用 `--query` 做 JMESPath 投影，`--format` 选择输出格式，`--dry-run` 检查即将发出的请求。`--all` 自动读取分页；`watch` 输出逐行事件并可通过游标恢复。删除/撤销操作要求 `--confirmed`。

## 凭据与错误

不要把 key 写入命令参数、提交到仓库或公开日志。可以通过环境变量、受限文件或标准输入传入。CLI debug 会隐藏认证头和请求正文，但正常响应可能含新创建的 key 或邮件内容，应按其敏感性保存。

401 表示需要检查凭据；403 表示权限不足，不应反复重试；发送结果不明确时用幂等键和 submission 查询确认，避免重复发送。`grove-mail errors` 显示退出码。
