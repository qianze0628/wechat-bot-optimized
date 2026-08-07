// 群信息模块 - 从本地消息记录读取群聊信息
import fs from 'fs'
import path from 'path'

const DATA_FILE = path.join(process.cwd(), '.data/wechat/messages.jsonl')

/**
 * 读取本地消息记录
 */
function readMessages() {
  try {
    if (!fs.existsSync(DATA_FILE)) return []
    const lines = fs.readFileSync(DATA_FILE, 'utf8').trim().split('\n').filter(Boolean)
    return lines.map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch (e) {
    console.error('读取消息记录失败:', e.message)
    return []
  }
}

/**
 * 获取群列表（群名 + 最近消息条数）
 */
export function listRooms() {
  const msgs = readMessages()
  const roomMap = {}
  for (const m of msgs) {
    if (m.isRoom && m.roomName) {
      if (!roomMap[m.roomName]) roomMap[m.roomName] = { name: m.roomName, count: 0 }
      roomMap[m.roomName].count++
    }
  }
  return Object.values(roomMap)
}

/**
 * 获取群成员（从该群的发言者提取）
 */
export function listRoomMembers(roomName) {
  const msgs = readMessages().filter((m) => m.isRoom && m.roomName === roomName)
  const members = new Set()
  for (const m of msgs) {
    if (m.talkerName) members.add(m.talkerName)
  }
  return [...members]
}

/**
 * 获取群最近 N 条消息
 */
export function getRoomRecentMessages(roomName, count = 10) {
  const msgs = readMessages()
    .filter((m) => m.isRoom && m.roomName === roomName && m.text)
    .slice(-count)
  return msgs.map((m) => ({
    from: m.talkerName,
    text: m.text,
    time: m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '',
  }))
}

/**
 * 格式化群信息为文本（给 AI 的上下文）
 */
export function formatRoomContext(roomName, count = 10) {
  const members = listRoomMembers(roomName)
  const recent = getRoomRecentMessages(roomName, count)
  let out = `【群聊：${roomName}】\n`
  out += `群成员（按发言记录）：${members.slice(0, 20).join('、')}\n`
  out += `最近 ${recent.length} 条消息：\n`
  for (const m of recent) {
    out += `  ${m.from}（${m.time}）：${m.text}\n`
  }
  return out
}
