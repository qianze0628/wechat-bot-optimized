// 对话记忆模块 - 内存短期记忆
// 每个会话保留最近 N 轮对话，拼接成上下文文本

const MAX_ROUNDS = 20 // 每个会话最多保留的轮数（一轮=一问一答）
const MAX_TOTAL_LEN = 3000 // 拼接后的最大字符数

// 内存存储：key = 会话标识（私聊=对方昵称，群聊=群名）
const memoryStore = new Map()

/**
 * 获取会话 key
 * @param {boolean} isRoom 是否群聊
 * @param {string} roomName 群名
 * @param {string} contactName 联系人昵称
 */
export function getSessionKey(isRoom, roomName, contactName) {
  return isRoom ? `room:${roomName}` : `user:${contactName}`
}

/**
 * 记录一条对话（用户问题 + AI回复）
 */
export function remember(sessionKey, userText, aiReply) {
  if (!memoryStore.has(sessionKey)) {
    memoryStore.set(sessionKey, [])
  }
  const history = memoryStore.get(sessionKey)
  history.push({ role: 'user', content: userText })
  if (aiReply) {
    history.push({ role: 'assistant', content: aiReply })
  }
  // 只保留最近 MAX_ROUNDS 轮
  while (history.length > MAX_ROUNDS * 2) {
    history.shift()
  }
  // 控制总长度（溢出时从前面丢）
  let totalLen = history.reduce((sum, m) => sum + m.content.length, 0)
  while (totalLen > MAX_TOTAL_LEN && history.length > 2) {
    history.shift()
    totalLen = history.reduce((sum, m) => sum + m.content.length, 0)
  }
}

/**
 * 获取会话历史（格式化为文本）
 */
export function getHistory(sessionKey) {
  const history = memoryStore.get(sessionKey) || []
  if (!history.length) return ''
  return history
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n')
}

/**
 * 清空会话历史
 */
export function clearHistory(sessionKey) {
  memoryStore.delete(sessionKey)
}

/**
 * 导出记忆模块内部状态（调试用）
 */
export function debugMemory() {
  return [...memoryStore.entries()].map(([k, v]) => `${k}: ${v.length}条`)
}
