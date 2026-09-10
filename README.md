# pi-telegram-mux

A Telegram Forum Supergroup multiplexer extension for [Pi](https://github.com/earendil-works/pi). View execution results, send new tasks, and stop ongoing runs in your local Pi coding agent right from Telegram.

English | [简体中文](README.zh-CN.md)

---

## Features

- **Bi-directional Interaction**: Send prompts on your computer and sync prompts along with final responses to Telegram. Reply directly inside a topic on Telegram to dispatch new tasks to Pi on your computer.
- **Multi-session Multiplexing**: Multiple running Pi instances share a single Telegram Bot. Each Pi session maps to its own dedicated Forum Topic without requiring external servers or background daemons.
- **Automatic Binding & Lifecycle**: Creates a topic on the first prompt in a new session and reuses it when the session is restored.
- **Remote Control**: Query session status or abort currently running tasks directly from Telegram.
- **Restricted Access**: Accepts tasks only from the configured Telegram User ID for security.

*Note: Synchronized content includes prompts and the assistant's final text responses; real-time tool execution logs and file attachments are not sent.*

## Installation

Requires Node.js 22.19+ and Pi 0.85.0+. Designed for Pi's interactive terminal.

### From npm (Recommended)

Global installation (available across all projects):

```bash
pi install npm:pi-telegram-mux
```

To install only for the current project, add the `-l` flag:

```bash
pi install -l npm:pi-telegram-mux
```

### Other Installation Methods

Directly from the Git repository:

```bash
pi install git:github.com/hkfires/pi-telegram-mux
```

Or from a local project directory:

```bash
pi install /path/to/pi-telegram-mux
```

To test or load temporarily for the current run:

```bash
pi -e /path/to/pi-telegram-mux/extensions/index.ts
```

## First-time Configuration

### 1. Prepare Telegram

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts to create your bot and obtain the **Bot Token**.
2. Create a Telegram Supergroup and enable **Topics** in the group settings.
3. Add the bot to the supergroup as an administrator with permissions to manage topics and send messages.
4. Obtain the group **Chat ID** (usually starts with `-100`) and your own **User ID**. You can use [@RawDataBot](https://t.me/RawDataBot) in the group to find the Chat ID, and private message [@userinfobot](https://t.me/userinfobot) to find your User ID.

### 2. Configure in Pi

Run this command in Pi to open the settings menu:

```text
/tg-setup
```

| Option | Purpose |
| --- | --- |
| Connection settings | Set the Bot Token, group Chat ID, and allowed User ID |
| Auto-close topics | Automatically close topics when leaving sessions; off by default |

Configuration is stored in `~/.pi/agent/pi-telegram-mux/config.json` by default (or under `PI_CODING_AGENT_DIR` if defined).

## Daily Usage

1. In a fresh Pi session on your computer, ask a question (e.g., "Analyze the project directory structure").
2. The extension automatically creates a Telegram topic (e.g., `Pi: my-project [a1b2c3]`) and syncs the prompt.
3. Once Pi completes the task, the final assistant response appears in the topic.
4. Send a text message in that topic to submit the next task. Pi on your computer must remain running.

For an existing session with history that is not yet bound to a topic, run `/tg-connect` to bind manually.

If the original topic has been deleted, restoring the session displays a warning. The extension waits for your next prompt in Pi before creating a replacement and syncing that prompt and its response. Restoring or viewing the session, or running `/tg-connect`, does not immediately recreate the topic. This pending replacement is saved with the session, so reopening Pi does not restore the deleted topic's binding.

### Image Input

Send a photo or image file in the bound Telegram topic and write your request in the caption. You can also send it without a caption; no default prompt is added.

To ask about several images together, send them as a Telegram album (up to 10 images). They are submitted as one task and numbered `[Image#1]`, `[Image#2]`, etc. Separate uploads are not merged.

**Notes:**

- Use `/model` to select a vision-capable model. JPEG, PNG, GIF, and WebP are supported; other attachments are not.
- The extension does not limit single-image or album file sizes, but Telegram and the model service may reject them. New inputs may be temporarily refused when the session is busy.
- If an album image cannot be downloaded or read, the whole album is rejected. Late-arriving images produce a notice rather than starting another task.
- Images sent to Pi are kept locally and are not automatically deleted. The default folder is `~/.pi/agent/pi-telegram-mux/media/`; if `PI_CODING_AGENT_DIR` is set, use `pi-telegram-mux/media/` under that directory. Delete unneeded images manually to free disk space. Deleted files can no longer be opened using their old paths.

**Restart all Pi instances after upgrading to avoid mixing old and new versions.**

### Telegram Commands

Send text in a topic to submit a task. These commands automatically appear in the authorized user's Telegram `/` menu—just select one:

| Command | Purpose |
| --- | --- |
| `/model` | Choose a model using buttons, with pagination |
| `/thinking` | Choose a thinking level using buttons |
| `/inputmode` | Choose busy input mode (follow-up or steering) using buttons |
| `/status` | View session status |
| `/stop` | Stop the current task |

### Pi Terminal Commands

| Command | Purpose |
| --- | --- |
| `/tg-setup` | Configure Telegram integration |
| `/tg-status` | Display connection status, current topic, and error details |
| `/tg-connect` | Create a topic, resume existing binding, or reconnect after an issue |
| `/tg-disconnect` | Detach the current session from Telegram (preserves the forum topic) |

### Status Bar Indicators

| Status | Meaning |
| --- | --- |
| `tg: unconfigured` | Not configured yet. Run `/tg-setup` |
| `tg: ready` | Ready. A topic will be created on the first prompt of a new session |
| `tg: topic deleted` | The original topic was deleted; the next prompt will create a replacement |
| `tg: connected (…)` | Current session is bound to a Telegram topic |
| `tg: disconnected` | Synchronization manually disconnected |
| `tg: offline` / `tg: reconnecting` | Offline or attempting reconnection |
| `tg: 429 · …` | Shared rate-limit cooldown; pending output is dropped, sync resumes automatically |
| `tg: conflict (409)` | Another process is polling updates with the same Bot Token |
| `tg: error` | Connection or sync error. Run `/tg-status` to inspect details |

If synchronization fails, check `/tg-status` first, resolve the reported issue, and run `/tg-connect`. To adjust credentials, run `/tg-setup`. If an operation reports "result unknown", check your Pi terminal and Telegram group before retrying.

Prompts and final responses are delivered and stored within Telegram, and Pi maintains its own local session records. The extension does not store separate chat logs.

## Limitations

Pi 0.85's normal input API lacks queue confirmation and source tracking, so busy Follow-up and Steering inputs use the extension-message queue to avoid false receipt confirmations or mismatched status updates. They appear as Telegram messages in Pi, bypass other extensions' input transformations, and do not appear in the ordinary pending-text queue. Idle input is unaffected.

## License

MIT
