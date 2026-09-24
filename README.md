# Grove Mail CLI

[![CLI checks](https://github.com/osokuruk606/grove-mail-cli/actions/workflows/check.yml/badge.svg)](https://github.com/osokuruk606/grove-mail-cli/actions/workflows/check.yml)

面向 Agent 和开发者的邮件命令行工具。通过 Grove Mail API 管理邮箱、收发邮件、处理会话和附件，并持续接收新邮件事件。

支持 JSON 输出、机器可读的命令描述、请求预览、分页、幂等请求和可恢复的事件监听。客户端覆盖固定 AgentMail CLI **1.5.0 的 140 个 API 操作**，另提供 Grove 短命令及扩展；实际可用能力由连接的服务和账号权限决定。

本仓库包含 CLI、接口描述、测试和文档。邮件服务器、网页邮箱、管理页和部署配置由 Grove Mail 服务项目维护。安装 CLI 只需要 Node.js 和服务凭据。

## 目录

- [安装](#安装)
- [认证](#认证)
- [快速开始](#快速开始)
- [命令发现](#命令发现)
- [进阶使用](#进阶使用)
- [开发与验证](#开发与验证)
- [兼容性与许可](#兼容性与许可)

## 安装

需要 **Node.js 24 或更新版本**、npm 和 Git。当前仓库为私有，克隆需要 GitHub 访问权限；尚未发布 npm registry 包或预编译 Release。

### 从源码安装（macOS / Linux）

```sh
git clone https://github.com/osokuruk606/grove-mail-cli.git
cd grove-mail-cli
npm ci
bash scripts/install-cli.sh
export PATH="$HOME/.local/bin:$PATH"
grove-mail --version
```

安装脚本把命令连接到当前源码目录的构建产物，默认放在 `~/.local/bin`。保留该目录，并将 PATH 设置加入你的 shell 配置。更新时执行 `git pull` 和 `npm ci`，后者会重新构建。

### 制作可独立安装的包

在源码目录执行：

```sh
npm pack
npm install --global ./opengrove-grove-mail-cli-0.2.1.tgz
grove-mail --help
```

tarball 包含运行文件和接口描述，安装后不依赖源码目录。也可以直接运行 `node dist/cli.js --help`。目前自动检查覆盖 Linux，本地验收覆盖 macOS；Windows 尚未单独验收。

## 认证

默认 API 入口为 `https://mail.openmau.com/agent`。连接其他 Grove Mail 部署时，设置 `GROVE_MAIL_BASE_URL` 或传入 `--base-url`。

### 已有 API key

```sh
grove-mail auth login
grove-mail auth status
grove-mail inboxes list
```

`auth login` 从标准输入读取 key：粘贴后按回车，再按 Ctrl-D。也可以使用 `grove-mail auth login --key-file /安全路径/grove-key.txt`。凭据保存在 `~/.config/grove-mail/config.json`，Unix 文件权限为 `0600`。

`auth status` 检查本机是否配置凭据；`inboxes list` 才会连接服务器验证访问权限。`auth logout` 删除本机保存的凭据。

Agent 或 CI 可以通过 `GROVE_MAIL_API_KEY` 环境变量提供 key，优先级高于配置文件。CLI 也会从当前目录向上查找最近的 `.env`，加载允许的 `GROVE_MAIL_*` 设置，且不覆盖已有环境变量。服务地址、代理、证书及配置文件位置等设置只接受命令参数或进程环境，不从 `.env` 加载。使用 `.env` 时，将它加入项目的 `.gitignore`。

### 申请新邮箱

当前 `mail.openmau.com` 关闭自助注册，新用户请联系管理员获取邮箱和 API key。已有账号照常登录使用。注册命令保留用于明确启用该功能的其他 Grove 部署；服务关闭注册时返回 `403 / signup_disabled`。

在已启用 Agent 注册的 Grove 服务上：

```sh
grove-mail agent sign-up --human-email owner@example.com --username your-agent
grove-mail auth login
grove-mail agent verify --otp-code 123456
```

替换现有邮箱地址、想要的邮箱名和收到的验证码。第一步返回新邮箱与 API key，第二步保存该 key，第三步验证邮箱归属。注册响应包含凭据，请勿发布到日志或 issue。是否开放注册及验证后的权限由服务端控制。

CLI 使用 API key，网页邮箱使用邮箱密码；CLI 注册不会返回网页邮箱密码。AgentMail 官方 key 与 Grove key 不互通。

## 快速开始

以下命令使用已经创建并授权的邮箱。将 `your-agent@openmau.com`、收件地址及邮件 ID 替换为自己的值。

### 查看邮箱和邮件

```sh
grove-mail inboxes list
grove-mail messages list --inbox your-agent@openmau.com --limit 20
grove-mail messages get --inbox your-agent@openmau.com --message msg_example
```

### 发送与回复

```sh
grove-mail messages send --inbox your-agent@openmau.com \
  --to recipient@example.com --subject 'Hello from Grove Mail' \
  --text 'Hello!' --idempotency-key task-001

grove-mail messages reply --inbox your-agent@openmau.com \
  --message msg_example --text '收到，谢谢。' --idempotency-key task-002
```

每次新的发送任务使用新的幂等键；同一任务重试时复用原来的键。邮件正文可改用 `--text-file body.txt` 或 `--html-file body.html`，附件使用 `--attach report.pdf`，多个附件可以重复传入。

### 监听与下载

```sh
grove-mail messages watch --inbox your-agent@openmau.com --cursor-file mail.cursor

grove-mail messages raw --inbox your-agent@openmau.com \
  --message msg_example --output original.eml
```

`watch` 持续输出逐行 JSON 事件，按 Ctrl-C 停止。再次使用同一游标文件运行时，可从保存的位置恢复。客户端监听要求进程保持运行；由服务端持续投递的回调使用 Webhook。`raw` 示例把原始邮件下载为 EML 文件。

## 命令发现

无需凭据即可查看帮助、请求字段和完整接口描述：

```sh
grove-mail --help
grove-mail inboxes messages --help
grove-mail inboxes drafts create --schema
grove-mail --schema
grove-mail --spec-raw
```

官方资源层级命令与 Grove 短命令都可使用，例如：

```sh
grove-mail inboxes messages list --inbox-id your-agent@openmau.com
grove-mail messages list --inbox your-agent@openmau.com
```

| 能力 | 命令入口示例 |
| --- | --- |
| 邮箱、邮件、会话、草稿、附件 | `inboxes`、`inboxes messages`、`inboxes threads`、`inboxes drafts` |
| 域名、API key、Webhook、名单 | `domains`、`api-keys`、`webhooks`、`lists` |
| 分组、统计、Agent 注册与身份接入 | `pods`、`metrics`、`agent`、`providers`、`accounts` |
| Grove 本地配置与事件监听 | `auth`、`messages watch`、`events watch` |

运行 `grove-mail <命令入口> --help` 查看具体操作。需要管理员权限或额外服务配置的命令不会因出现在帮助中就自动获得授权。详细说明见 [使用指南](docs/usage.md)。

## 进阶使用

### 常用参数

| 参数 | 用途 |
| --- | --- |
| `--dry-run` | 本地校验并显示请求，不发送到服务器 |
| `--json '{...}'` / `--json -` | 提供 JSON 请求体，或从标准输入读取 |
| `--body-file request.json` | 从文件读取请求体 |
| `--params '{...}'` | 提供参数对象，同名字段覆盖单独的参数 |
| `--query '表达式'` | 用 JMESPath 筛选输出字段 |
| `--format json` | 指定输出格式 |
| `--base-url URL` | 本次调用使用另一个服务入口 |
| `--all --max-pages 10` | 自动读取支持分页的列表，限制最多读取页数 |
| `--output 文件名` | 将下载内容写入文件 |
| `--idempotency-key 标识` | 为写入请求指定幂等键 |
| `--confirmed` | 明确确认删除或撤销操作 |
| `--quiet` | 成功时抑制普通输出 |

参数是否适用以具体命令的 `--help` / `--schema` 为准。`--json` 不与单独的请求体字段参数混用。

```sh
grove-mail messages send --inbox your-agent@openmau.com \
  --json '{"to":["recipient@example.com"],"subject":"Hello","text":"Hello!"}' \
  --dry-run
```

### 输出格式

支持 `json`、`table`、`yaml`、`csv`、`jsonl`、`raw` 和 `http`。交互终端默认表格，管道和重定向默认 JSON；监听命令输出逐行 JSON。

```sh
grove-mail inboxes list --format json
grove-mail inboxes list --query 'inboxes[].inbox_id' --format json
grove-mail messages list --inbox your-agent@openmau.com --all --format jsonl
```

需要固定脚本行为时显式设置 `--format`。`grove-mail errors` 显示退出码；401 需要检查认证，403 表示权限不足。

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `GROVE_MAIL_API_KEY` | API key，优先于本机保存的凭据 |
| `GROVE_MAIL_BASE_URL` | 覆盖默认 API 入口 |
| `GROVE_MAIL_CLIENT_CONFIG` | 使用另一份本机配置，便于分开身份 |
| `GROVE_MAIL_OUTPUT` | 默认输出格式 |
| `GROVE_MAIL_TIMEOUT_SECS` | 请求超时秒数，默认 120 |
| `GROVE_MAIL_PROXY` | HTTP(S) 代理地址 |
| `GROVE_MAIL_CA_BUNDLE` | 额外可信 CA 的 PEM 文件 |

同时支持标准 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 和 `SSL_CERT_FILE`。指定其他服务时，应使用该服务签发的凭据。

### Shell 补全与 Agent 说明

```sh
grove-mail completion bash > grove-mail-completion.bash
source ./grove-mail-completion.bash

grove-mail generate-skills --output-dir ./skills
grove-mail man > grove-mail.1
```

补全还支持 `zsh`、`fish`、`powershell` 和 `elvish`，请使用对应 shell 的加载方式。生成的技能文件包含命令说明，供 Agent 发现和调用。

## 开发与验证

```sh
npm ci
npm test
npm run build
npm run verify:package
```

`verify:package` 在临时目录安装实际 tarball，仅使用打包文件和运行依赖，验证命令发现及合成 HTTP 请求。客户端测试使用本地 fixture，不需要生产凭据或真实邮件。

可设置 `AGENTMAIL_CLI` 为未修改的官方 1.5.0 可执行文件，运行固定版本的行为对照；未设置时相关对照测试会跳过。GitHub Actions 会安装该版本并运行这些检查。

```sh
AGENTMAIL_CLI=/path/to/agentmail npm test
AGENTMAIL_CLI=/path/to/agentmail npm run cli:capture-operations
```

第二条命令对比 140 个操作的合成请求，结果写入被 Git 忽略的 `reports/`。它验证客户端请求构造，不证明托管服务的全部行为等价。

接口基线与来源见 [reference](docs/reference/README.md)。Grove 接口快照由服务项目的 `scripts/export-cli-schema.ts` 导出，客户端日常构建和测试不依赖服务端源码。

## 兼容性与许可

Grove Mail CLI 独立实现，使用 AgentMail CLI 1.5.0 的公开接口描述和实际行为作为兼容性基线。Grove 扩展包括短命令、本机凭据管理、SSE 监听和删除确认。第三方身份服务、自动 DNS 配置等能力还取决于所连接服务的外部配置。

本项目不是 AgentMail 官方客户端，也不隶属于 AgentMail。第三方接口描述的来源与归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

当前 Grove Mail CLI 尚未选择开源许可证，`package.json` 标记为 `UNLICENSED`。仓库可见性与代码的使用、修改、分发许可是不同的设置；正式开源时会明确项目许可，并保留第三方材料的声明。
