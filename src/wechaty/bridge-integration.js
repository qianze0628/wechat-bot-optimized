// wechat-bot 消息对象 → OneBot 事件 的适配层
// 由 wechat-bot 的 bot.js 在收到消息时调用

// 会话映射，模拟 OneBot 的 user_id / group_id
// 私聊: userId（用微信 contact.id 哈希成数字）→ 实际 contact
// 群聊: groupId（用群 id 哈希成数字）→ 实际 room
const contactMap = new Map()  // userId -> { contact, name }
const roomMap = new Map()     // groupId -> { room, topic }
const sessionTargetMap = new Map() // sessionId字符串 -> target对象

// 简单的字符串哈希（稳定生成 user_id/group_id）
export function hashId(str) {
  if (!str) str = 'unknown'
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash) + 10000 // 避开 10001 保留号
}

/**
 * 微信消息 → OneBot 会话映射
 * 用微信原始 id（contact.id / room.id）做哈希，保证每个联系/群唯一稳定
 * 返回 sessionId（用于 AstrBot 回复定位）
 */
export async function mapMessageToSession(msg, contact, room, roomName) {
  // 用名字做稳定 ID（contact.id 每次登录会变，导致会话丢失；名字稳定不变）
  const contactDisplayName = contact ? await awaitSafeName(contact) : '未知'
  const contactRawId = contactDisplayName
  const roomRawId = roomName || (room && room.id ? room.id : 'group')
  // 群成员也用自己的名字做 user 标识（保持会话稳定）
  const memberRawId = contactDisplayName

  if (room) {
    // 群聊
    const groupId = hashId(roomRawId)
    const userId = hashId(memberRawId)
    roomMap.set(groupId, { room, topic: roomName })
    contactMap.set(userId, { contact, name: contactDisplayName })
    const sessionId = `group_${groupId}`
    sessionTargetMap.set(sessionId, { type: 'group', room, contact, groupId, userId })
    console.log(`📇 会话映射: 群[${roomName}] rawId=${roomRawId} → group_${groupId}; 成员[${contactDisplayName}] rawId=${contactRawId} → user_${userId}`)
    return { sessionId, userId, groupId, isGroup: true }
  } else {
    // 私聊
    const userId = hashId(contactRawId)
    contactMap.set(userId, { contact, name: contactDisplayName })
    const sessionId = `user_${userId}`
    sessionTargetMap.set(sessionId, { type: 'private', contact, userId })
    console.log(`📇 会话映射: 联系人[${contactDisplayName}] rawId=${contactRawId} → user_${userId}`)
    return { sessionId, userId, isGroup: false }
  }
}

/**
 * 手动注册发送目标 (ChatUI 链路测试注入时调用)
 * 让 AstrBot 的回复能经 sessionTargetMap 打回该联系人
 * (正常链路由 mapMessageToSession 在真实消息到来时注册; 注入消息没有真实消息, 需显式注册)
 */
export function registerSendTarget(sessionId, target) {
  if (!sessionId || !target) return
  sessionTargetMap.set(sessionId, target)
  if (target.type === 'private') {
    contactMap.set(String(target.userId), { contact: target.contact, name: target.name || '' })
  }
}

// 取显示名（兼容异步 name / alias）
async function awaitSafeName(contact) {
  try {
    const alias = await contact.alias()
    if (alias) return alias
    const name = await contact.name()
    return name || '未知'
  } catch (e) {
    return '未知'
  }
}

/**
 * 根据 AstrBot 的回复 session 找到微信发送目标
 * @param {string} sessionId 如 'group_12345' 或 'user_67890'
 */
export function getSendTarget(sessionId) {
  return sessionTargetMap.get(sessionId) || null
}

/**
 * 导出内部映射（调试）
 */
export function debugBridgeState() {
  const contacts = []
  for (const [uid, v] of contactMap.entries()) {
    contacts.push(`${v.name}=user_${uid}`)
  }
  const rooms = []
  for (const [gid, v] of roomMap.entries()) {
    rooms.push(`${v.topic}=group_${gid}`)
  }
  return { contacts, rooms }
}

// 运行时 rawId(微信号) → 展示名 映射:
// contactMap 的 value 含 contact(有 .id = rawId) 与 name, 供群成员名补齐用
export function rawIdToNameMap() {
  const m = new Map()
  for (const [, v] of contactMap.entries()) {
    const c = v && v.contact
    const rid = c && (c.id || c.rawId || '')
    if (rid) {
      m.set(String(rid), v.name || '')
    }
  }
  return m
}