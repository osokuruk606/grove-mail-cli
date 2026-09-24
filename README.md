# Grove Mail CLI

Grove Mail 的独立命令行客户端。给 Agent 提供邮箱管理、收发邮件、会话、附件、草稿、标签、通知和权限操作。

本仓库只包含客户端、接口描述、文档和测试。邮件服务、网站、mailcow、部署配置和运行数据由独立的 Grove Mail 服务仓库维护。CLI 通过 HTTPS 连接服务，安装本工具不需要部署邮件服务器。

## 安装

需要 Node.js 24 或更新版本。仓库目前为私有，获取源码需要相应 GitHub 访问权限；尚未发布 npm registry 包。

```sh
git clone https://github.com/osokuruk606/grove-mail-cli.git
cd grove-mail-cli
npm ci
bash scripts/install-cli.sh
grove-mail --version
```

也可以制作包含全部运行文件的安装包，在其他电脑安装：

```sh
npm pack
npm install --global ./opengrove-grove-mail-cli-0.2.1.tgz
```

## 连接服务

默认服务入口为 `https://mail.openmau.com/agent`。使用自己的 Grove Mail 部署时，传入 `--base-url` 或设置 `GROVE_MAIL_BASE_URL`。

已有 Grove API key：

```sh
grove-mail auth login
grove-mail inboxes list
grove-mail messages list --inbox your-agent@openmau.com
```

`auth login` 从标准输入读取 key：粘贴后按回车，再按 Ctrl-D。也可以使用 `--key-file /安全路径/key.txt`。凭据保存在本机权限为 0600 的配置文件；登录后执行 `inboxes list` 验证服务权限。AgentMail 官方 key 与 Grove key 不互通。

新 Agent 可在支持注册的 Grove 服务上申请邮箱并验证：

```sh
grove-mail agent sign-up --human-email 你的现有邮箱 --username your-agent
grove-mail auth login
grove-mail agent verify --otp-code 收到的六位验证码
```

注册返回的 key 用于第二步登录。CLI 注册不会返回网页邮箱密码。更多说明见 [使用指南](docs/usage.md)。

## 开发与验证

```sh
npm ci
npm test
npm run verify:package
```

`verify:package` 在临时目录安装实际 tarball，仅使用已打包文件和运行依赖，验证命令发现和合成 HTTP 请求。测试不读取生产密钥或邮件。

可设置 `AGENTMAIL_CLI` 为未修改的官方 1.5.0 可执行文件，以运行固定版本的行为对照。`npm run cli:capture-operations` 会对 140 个操作记录两边的合成请求；它验证客户端请求构造，不证明服务端业务完全等价。

接口基线和来源见 [reference](docs/reference/README.md)。客户端接口快照由服务仓库的 `scripts/export-cli-schema.ts` 导出；日常构建与测试不依赖服务仓库。
