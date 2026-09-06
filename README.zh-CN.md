# pi-telegram-mux

Pi 编码助手的 Telegram 论坛超级群多路复用插件。让你通过 Telegram 查看电脑上 Pi 助手的任务结果、发送新任务和中止执行。

[English](README.md) | 简体中文

---

## 功能

- **双向交互**：在电脑上提问，提示词与最终回复同步到手机；在手机话题中发送文字，交给电脑上的 Pi 执行。
- **多会话管理**：多个 Pi 实例共享一个 Telegram Bot，每个会话对应一个独立话题，无需额外部署服务。
- **自动连接与生命周期**：新会话首次提问时自动创建话题，恢复会话时继续使用原话题。
- **远程控制**：在手机查询会话状态，或中止正在执行的任务。
- **指定用户访问**：只接收配置的 Telegram 用户发来的任务。

*同步内容为提示词和助手最终文本回复，不包含实时工具输出或附件。*

## 安装

需要 Node.js 22.19 或更新版本，以及 Pi 0.85.0 或更新版本。本插件用于 Pi 的交互式终端。

### 从 npm 安装（推荐）

全局安装（所有项目可用）：

```bash
pi install npm:pi-telegram-mux
```

若仅安装到当前项目，添加 `-l` 参数：

```bash
pi install -l npm:pi-telegram-mux
```

### 其他安装方式

也可以直接从 Git 仓库安装：

```bash
pi install git:github.com/hkfires/pi-telegram-mux
```

或者从本地项目目录安装：

```bash
pi install /path/to/pi-telegram-mux
```

仅安装到当前项目时添加 `-l`；临时加载可使用：

```bash
pi -e /path/to/pi-telegram-mux/extensions/index.ts
```

## 首次配置

### 1. 准备 Telegram

1. 向 [@BotFather](https://t.me/BotFather) 发送 `/newbot`，按提示创建 Bot 并获取 **Bot Token**。
2. 创建群组，在群组设置中开启 **Topics（话题）**。
3. 将 Bot 加入群组并设为管理员，授予管理话题和发送消息的权限。
4. 获取群组的 **Chat ID**（通常以 `-100` 开头）和你自己的 **用户 ID**。可借助 [@RawDataBot](https://t.me/RawDataBot) 查看群组消息信息，向 [@userinfobot](https://t.me/userinfobot) 私聊查询自己的用户 ID。

### 2. 在 Pi 中配置

在 Pi 中运行以下命令，打开设置菜单：

```text
/tg-setup
```

| 选项 | 作用 |
| --- | --- |
| Connection settings（连接配置） | 设置 Bot Token、群组 Chat ID 和允许使用的用户 ID |
| Auto-close topics（自动关闭话题） | 离开会话时自动关闭话题，默认关闭 |

配置默认保存在 `~/.pi/agent/pi-telegram-mux/config.json`。如果设置了 `PI_CODING_AGENT_DIR`，则使用该目录。

## 日常使用

1. 在电脑上的空白 Pi 会话中提问，例如“分析这个项目的目录结构”。
2. 插件会自动创建类似 `Pi: my-project [a1b2c3]` 的 Telegram 话题，并同步提示词。
3. 任务完成后，在手机话题中查看最终回复。
4. 在该话题直接发送文字，即可提交下一项任务。电脑上的 Pi 需要保持运行。

已有历史但未绑定话题的会话，使用 `/tg-connect` 手动连接。

### 手机端命令

| 操作 | 用途 |
| --- | --- |
| 直接发送文字 | 向对应的 Pi 会话提交新任务 |
| `/status` | 查看该话题对应的会话状态 |
| `/stop` | 中止该会话正在执行的任务 |

*命令也支持 `/status@你的Bot用户名` 和 `/stop@你的Bot用户名`。Pi 忙碌时，请等待当前任务完成后再提交新任务。*

### Pi 终端命令

| 命令 | 用途 |
| --- | --- |
| `/tg-setup` | 配置 Telegram 插件 |
| `/tg-status` | 查看连接状态、当前话题和错误信息 |
| `/tg-connect` | 创建话题、恢复已有绑定，或在同步异常后重新连接 |
| `/tg-disconnect` | 停止当前会话的同步，保留群内话题 |

### 状态栏

| 显示 | 含义 |
| --- | --- |
| `tg: unconfigured` | 尚未配置，运行 `/tg-setup` |
| `tg: ready` | 已就绪，空白会话首次提问时可创建话题 |
| `tg: connected (…)` | 当前会话已连接话题 |
| `tg: disconnected` | 已手动断开同步 |
| `tg: offline` / `tg: reconnecting` | 离线或正在重连 |
| `tg: conflict (409)` | 其他程序正在使用同一个 Bot 接收消息 |
| `tg: error` | 连接或同步异常，运行 `/tg-status` 查看原因 |

遇到同步异常，先查看 `/tg-status`，处理提示的问题后运行 `/tg-connect`；需要修改配置时运行 `/tg-setup`。如果提示任务或话题创建“结果未知”，请先检查电脑上的会话和群内话题，再决定是否重试。

提示词和回复会发送并保存在 Telegram，Pi 也会保存自身会话记录；插件不额外保存聊天副本。

## 许可证

MIT
