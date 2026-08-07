# wechat-bot (微信 AI 桥接器·优化版)

个人微信 AI 机器人桥接器:基于 **Wechaty + wechat4u** 登录个人微信,
对接 **AstrBot (OneBot v11)** 或其他 OpenAI 兼容服务,支持:

- 🔌 **OneBot v11 桥接**:消息事件推送到 AstrBot,回复经桥接发回微信
- 📋 **白名单机制**:按联系人/群名精确控制谁可以触发 AI(同步 AstrBot 面板)
- 👥 **群消息记录**:本地 `messages.jsonl` 持久化 + 群成员名本地反推
- 🔑 **会话稳定映射**:用名字哈希生成稳定 user_id/group_id,不随登录态变化
- 🖥️ **HTTP 管理 API**(端口 6189):`/api/contacts`(联系人/群/成员)、`/api/status`
- 📇 **公众号识别**:区分真人联系人 vs 公众号/服务号
- 🎭 **按群人设**:可为指定群注入专属身份设定

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境 (从模板复制)
cp .env.example .env
#    编辑 .env: 填 AI Key、白名单(你的昵称/联系人/群)

# 3. 启动并扫码登录
node cli.js start -s ChatGPT
#    终端会出现二维码, 用手机微信扫码登录
```

登录成功后保持进程运行即可。API 默认端口 **6189**:

```
http://127.0.0.1:6189/api/status      # 登录状态
http://127.0.0.1:6189/api/contacts    # 联系人/群/群成员
```

## 与 AstrBot 配合

本桥接器是 `wechat-ai-panel` 面板生态的一部分:

1. AstrBot 配 `aiocqhttp` 平台,反向 WS 指向本桥接器
2. 面板的白名单/管理员设置在 AstrBot 侧生效,桥接器按 `.env` 白名单拦截
3. 群成员名拿不到时,桥接器会从本地消息记录反推真实昵称

## 环境变量

| 变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | AI 服务 Key |
| `OPENAI_PROXY_URL` | OpenAI 兼容代理地址 |
| `OPENAI_MODEL` | 模型名 |
| `SERVICE_TYPE` | 服务类型(ChatGPT/doubao/deepseek/Kimi/.../claude/pi) |
| `BOT_NAME` | 你的微信昵称(群聊被@时触发) |
| `ALIAS_WHITELIST` | 允许自动回复的联系人(逗号分隔) |
| `ROOM_WHITELIST` | 允许自动回复的群聊(逗号分隔) |
| `NO_MENTION_ROOMS` | 免@群(群内所有消息都触发) |
| `SENSITIVE_WORDS` | AI 回复禁止出现的词(自动替换) |
| `WECHAT_DATA_DIR` | 消息记录目录(默认 `.data/wechat`) |
| `WECHAT_STORE_MESSAGES` | 是否记录消息到本地 |

## 目录说明

```
src/
├── platforms/wechat/bot.js     # 微信主逻辑 (登录/消息/白名单/API)
├── platforms/wechat/messageStore.js  # 消息持久化
├── wechaty/
│   ├── bridge-integration.js   # 微信消息 → OneBot 会话映射 (hashId)
│   ├── onebot-bridge.js        # OneBot v11 WS 客户端
│   ├── groupinfo.js            # 群信息 (成员/消息)
│   └── ...
└── openai/ doubao/ deepseek/ ...  # 各 AI 服务适配器
```

## 免责声明

本项目仅供学习与技术交流。请遵守微信使用规范,控制频率,勿用于骚扰、营销等用途。
