// 微信 → AstrBot OneBot v11 桥接（WS 客户端模式）
// AstrBot 的 aiocqhttp 适配器 bind 端口当 WS 服务端，我们作为客户端连它
import WebSocket from 'ws'

// ===== 配置 =====
const ASTRBOT_WS_HOST = process.env.ASTRBOT_WS_HOST || '127.0.0.1'
const ASTRBOT_WS_PORT = 20129 // AstrBot aiocqhttp 监听端口
const WS_URL = `ws://${ASTRBOT_WS_HOST}:${ASTRBOT_WS_PORT}/ws`

// ===== 本地消息读取（供群分析插件 get_group_msg_history 使用）=====
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const MESSAGES_FILE = path.resolve(__dirname, '../../.data/wechat/messages.jsonl')
// 群名 -> hashId(群名) 缓存, 用于把群名转成 OneBot group_id 反向匹配
// 注意: 群分析传入的是 group_id(数字), 而本地消息记录的是 roomName(群名)
// 用 bridge-integration 的 hashId 算法反查群名
function hashId(str) {
  if (!str) str = 'unknown'
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash) + 10000
}

/**
 * 从本地消息记录查找某条消息 (用于 get_msg)
 */
function findLocalMessage(msgId) {
  try {
    if (!fs.existsSync(MESSAGES_FILE)) return null
    const lines = fs.readFileSync(MESSAGES_FILE, 'utf-8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const d = JSON.parse(line)
        if (String(d.id) !== String(msgId)) continue
        return {
          message_id: Number(d.id) || 0,
          user_id: Number(hashId(d.talkerName || '')) || 0,
          message: [{ type: 'text', data: { text: d.text || '' } }],
          raw_message: d.text || '',
          sender: { user_id: Number(hashId(d.talkerName || '')) || 0, nickname: d.talkerName || '微信用户', card: '' },
          time: Math.floor(new Date(d.timestamp).getTime() / 1000),
          group_id: d.isRoom ? Number(hashId(d.roomName || '')) || 0 : undefined,
        }
      } catch (e) {}
    }
    return null
  } catch (e) {
    return null
  }
}

/**
 * 从本地消息记录反查用户名（用于 get_group_member_info / get_stranger_info）
 * userId 可能是 hashId(名字) 数字, 也可能是名字本身
 */
function resolveUserName(userId) {
  try {
    if (!fs.existsSync(MESSAGES_FILE)) return userId
    const lines = fs.readFileSync(MESSAGES_FILE, 'utf-8').split('\n')
    const seen = new Set()
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const d = JSON.parse(line)
        const name = d.talkerName || ''
        if (!name) continue
        // 方法1: userId 就是名字
        if (String(userId) === name) return name
        // 方法2: userId 是 hash(name)
        const key = name + ':' + String(hashId(name))
        if (seen.has(key)) continue
        seen.add(key)
        if (String(hashId(name)) === String(userId)) return name
      } catch (e) {}
    }
    return String(userId)
  } catch (e) {
    return String(userId)
  }
}

/**
 * 从本地 messages.jsonl 读取某个群的文本消息
 * 返回 OneBot 格式的 messages 数组 (供 get_group_msg_history)
 */
function readLocalGroupMessages(groupId, count = 100) {
  try {
    if (!fs.existsSync(MESSAGES_FILE)) return []
    const lines = fs.readFileSync(MESSAGES_FILE, 'utf-8').split('\n')
    const result = []
    for (let i = lines.length - 1; i >= 0 && result.length < count; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const d = JSON.parse(line)
        // 群聊消息, 且该群的 hashId(群名) 匹配传入的 group_id
        if (!d.isRoom || !d.roomName) continue
        if (String(hashId(d.roomName)) !== String(groupId)) continue
        if (!d.isText || !d.text) continue
        result.push({
          message_id: String(d.id || ''),
          real_id: String(d.id || ''),
          user_id: String(d.talkerName || ''),
          message: [{ type: 'text', data: { text: d.text } }],
          raw_message: d.text,
          sender: { user_id: String(d.talkerName || ''), nickname: d.talkerName || '', card: '' },
          time: Math.floor(new Date(d.timestamp).getTime() / 1000),
        })
      } catch (e) {}
    }
    return result
  } catch (e) {
    console.error('❌ 读取本地消息失败:', e.message)
    return []
  }
}

// ===== 状态 =====
let ws = null
let reconnectTimer = null
let reconnectAttempts = 0
let sendWechatMessage = null
let connected = false

/**
 * 初始化桥接（WS 客户端，自动重连）
 */
export function startOneBotBridge(opts = {}) {
  sendWechatMessage = opts.sendWechat || null
  connect()
  console.log(`🔌 OneBot 桥接客户端初始化，目标 ws://${ASTRBOT_WS_HOST}:${ASTRBOT_WS_PORT}`)
}

// 连接状态回调（供外部查询）
export function isBridgeConnected() {
  return connected
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return
  try {
    ws = new WebSocket(WS_URL, {
      headers: { 'X-Client-Role': 'Universal', 'X-Self-ID': '10001' },
    })
  } catch (e) {
    console.error('🔌 WebSocket 创建失败:', e.message)
    scheduleReconnect()
    return
  }

  ws.on('open', () => {
    connected = true
    reconnectAttempts = 0
    console.log(`🔌 OneBot 桥接已连接 AstrBot: ${WS_URL}`)
  })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      console.log('📨 收到 AstrBot 调用:', JSON.stringify(msg).slice(0, 200))
      if (msg.echo !== undefined) {
        await handleApiCall(msg)
      }
    } catch (e) {
      console.error('❌ 解析失败:', e.message)
    }
  })

  ws.on('close', () => {
    connected = false
    console.log('🔌 连接断开，尝试重连...')
    scheduleReconnect()
  })

  ws.on('error', (e) => {
    // error 后 close 会触发重连
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(10000, 1000 * (reconnectAttempts + 1))
  reconnectAttempts++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
  console.log(`🔌 将在 ${delay / 1000}s 后重连...`)
}

/**
 * 处理 AstrBot 发来的 API 调用
 */
async function handleApiCall(msg) {
  const action = msg.action
  const params = msg.params || {}
  let result = { retcode: 0, status: 'ok', data: null }

  switch (action) {
    case 'send_msg':
    case 'send_private_msg':
    case 'send_group_msg': {
      const text = extractText(params.message)
      // 提取图片段: 优先 base64, 其次 url
      let imageBase64 = null
      let imageUrl = null
      // 提取 at 段 (@目标用户, 发送时转成微信 @)
      let atUserIds = []
      const msgList = Array.isArray(params.message) ? params.message : []
      for (const seg of msgList) {
        if (seg.type === 'image') {
          const f = seg.data?.file || ''
          if (f.startsWith('base64://')) imageBase64 = f.slice(9)
          else if (f) imageUrl = f
          else if (seg.data?.url) imageUrl = seg.data.url
        } else if (seg.type === 'at' && seg.data?.qq && String(seg.data.qq) !== String(msg.self_id || 10001)) {
          atUserIds.push(String(seg.data.qq))
        }
      }
      const userId = params.user_id
      const groupId = params.group_id
      console.log(`📤 发送消息: ${text} → user=${userId} group=${groupId} image=${imageBase64 ? 'base64(' + imageBase64.length + ')' : (imageUrl || '无')} at=${atUserIds.join(',')}`)
      if (sendWechatMessage) {
        const sessionId = groupId ? `group_${groupId}` : `user_${userId}`
        try {
          await sendWechatMessage(sessionId, text, { imageBase64, imageUrl, atUserIds, groupId })
          result.data = { message_id: Math.floor(Math.random() * 100000) }
        } catch (e) {
          console.error('❌ 发送微信失败:', e.message)
          result = { retcode: 100, status: 'failed', data: null, message: e.message }
        }
      }
      break
    }
    case 'get_login_info':
      result.data = { user_id: 10001, nickname: '微信机器人' }
      break
    case 'get_group_msg_history': {
      // 群分析插件拉历史消息: 从本地 messages.jsonl 返回该群的文本消息
      const groupId = String(params.group_id || '')
      const count = Number(params.count || 100)
      const messages = readLocalGroupMessages(groupId, count)
      result.data = { messages }
      break
    }
    case 'get_group_member_info':
    case 'get_stranger_info': {
      // @ 段解析需要: 返回成员信息(从本地消息记录反查昵称)
      const userId = String(params.user_id || '')
      // userId 可能是 hashId(名字) 或真实名字, 尽力反查
      result.data = {
        group_id: Number(params.group_id || 0),
        user_id: Number(userId) || 0,
        nickname: resolveUserName(userId),
        card: resolveUserName(userId),
        role: 'member',
      }
      break
    }
    case 'get_msg': {
      // 引用消息解析需要: 返回被引用消息的详情(从本地消息记录查找)
      const msgId = String(params.message_id || '')
      const found = findLocalMessage(msgId)
      if (found) {
        result.data = {
          ...found,
          post_type: 'message',
          message_type: found.group_id ? 'group' : 'private',
        }
      } else {
        // 找不到则返回一条最小消息(让 reply 段能构造成功)
        result.data = {
          post_type: 'message',
          message_type: 'private',
          user_id: 1158783,
          message_id: Number(msgId) || 0,
          message: [{ type: 'text', data: { text: '引用消息' } }],
          raw_message: '引用消息',
          sender: { user_id: 1158783, nickname: '微信用户', card: '' },
          time: Math.floor(Date.now() / 1000),
        }
      }
      break
    }
    default:
      result = { retcode: 0, status: 'ok', data: {} }
  }

  if (msg.echo !== undefined && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...result, echo: msg.echo }))
    console.log('📨 已发送 API 响应')
  }
}

/**
 * 从 OneBot 消息格式提取文本
 */
function extractText(message) {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    return message.filter((m) => m.type === 'text').map((m) => m.data?.text || '').join('')
  }
  return String(message || '')
}

/**
 * 推送微信消息给 AstrBot（发送 OneBot 事件）
 */
export function pushWechatMessage(data) {
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    console.log('⚠️ AstrBot 未连接，消息未推送')
    return false
  }
  // 组装 OneBot 消息段：文本 + 图片 + 视频
  const segments = []
  // 引用消息识别: wechat4u 格式 「被引用:内容」\n- - - - -\n新消息
  const rawText = data.text || ''
  let isQuote = false
  let quoteSender = ''
  const quoteMatch = /「([^：」]+)：(.*?)」\s*\n- - - - - - - - - - - - - - -\n([\s\S]*)/.exec(rawText)
  if (quoteMatch) {
    isQuote = true
    quoteSender = quoteMatch[1]
  }
  // 群消息: @ 消息(唤醒) 或 引用消息(仅附 reply 段, 唤醒由 AstrBot 判断是否引用机器人)
  const hasMention = data.messageType === 'group' && /@[一-龥a-zA-Z0-9_\-\s]{0,20}/.test(rawText)
  if (hasMention || isQuote || (data.messageType === 'group' && data.forceAt)) {
    let body = rawText
      .replace(/「[\s\S]*?」\s*\n-{5,}\n/, '')  // 剥掉引用头
      .replace(/@[一-龥a-zA-Z0-9_\-\s]{0,20}/g, '')  // 剥掉 @名
      .trim()
    if (body) segments.push({ type: 'text', data: { text: body } })
    // 引用消息: 附 reply 段 (AstrBot 会调 get_msg 判断被引用人)
    if (isQuote) segments.push({ type: 'reply', data: { id: String(data.messageId || ''), name: quoteSender } })
    // 只有真正 @ 机器人 或 forceAt 才附 at 段 (唤醒)
    if (hasMention || (data.messageType === 'group' && data.forceAt)) {
      segments.push({ type: 'at', data: { qq: String(data.selfId || 10001) } })
    }
  } else if (data.text) {
    segments.push({ type: 'text', data: { text: data.text } })
  }
  if (data.imageBase64) segments.push({ type: 'image', data: { file: `base64://${data.imageBase64}` } })
  else if (data.imageUrl) segments.push({ type: 'image', data: { file: data.imageUrl, url: data.imageUrl } })
  if (data.videoUrl) segments.push({ type: 'video', data: { file: data.videoUrl, url: data.videoUrl } })
  if (!segments.length) segments.push({ type: 'text', data: { text: '[空消息]' } })
  const rawMessage = data.text || (data.imageUrl ? '[图片]' : data.videoUrl ? '[视频]' : '')
  const event = {
    post_type: 'message',
    message_type: data.messageType,
    user_id: data.userId,
    group_id: data.groupId || 0,
    message_id: Math.floor(Math.random() * 100000),
    raw_message: rawMessage,
    message: segments,
    sender: {
      user_id: data.userId,
      qq: data.userId, // OneBot 规范字段 (AstrBot/插件可能访问 sender.qq)
      nickname: data.nickname || '微信用户',
      card: data.nickname || '',
    },
    time: Math.floor(Date.now() / 1000),
    self_id: data.selfId || 10001,
  }
  ws.send(JSON.stringify(event))
  console.log(`📨 推送微信→AstrBot: [${data.messageType}] ${data.nickname}: ${data.text}`)
  return true
}
