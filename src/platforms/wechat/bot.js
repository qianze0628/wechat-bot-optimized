import { WechatyBuilder, ScanStatus, log } from 'wechaty'

import http from 'http'

import path from 'path'

import { MemoryCard } from 'memory-card'

import qrTerminal from 'qrcode-terminal'

import { defaultMessage } from '../../wechaty/sendMessage.js'

import { captureWechatMessage, loadWechatMessages } from './messageStore.js'

// 从本地消息记录提取某群的真实成员昵称 (微信侧成员名可能解析失败时的兜底)
function _localRoomMemberNames(roomName) {
  try {
    const seen = new Map() // talkerName -> count
    for (const m of loadWechatMessages()) {
      if (m && m.isRoom && m.roomName === roomName && m.talkerName) {
        if (m.talkerName !== roomName && m.talkerName !== '未知') {
          seen.set(m.talkerName, (seen.get(m.talkerName) || 0) + 1)
        }
      }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)
  } catch (e) {
    return []
  }
}

import { startOneBotBridge, pushWechatMessage, isBridgeConnected } from '../../wechaty/onebot-bridge.js'

import { mapMessageToSession, getSendTarget, hashId as _hashIdRaw, rawIdToNameMap, registerSendTarget } from '../../wechaty/bridge-integration.js'
// 安全包装: hashId 对非字符串调用会报 charCodeAt 错
function _hashId(v) { return _hashIdRaw(typeof v === 'string' ? v : String(v || '')) }

import { getWechatRuntimeConfig } from '../../config/env.js'

// 全局运行时配置（文件级函数用，启动时赋值）
let globalConfig = null
function getGlobalConfig() {
  if (!globalConfig) globalConfig = getWechatRuntimeConfig()
  return globalConfig
}

// ===== 按群人设配置：仅在指定群聊注入该身份设定，其他场合不生效 =====
const ROOM_PERSONA = {
  rooms: ['电脑开黑'],
  contacts: ['徐邵博', 'A.'],  // 私聊也生效的联系人（备注名/微信名）
  text: '【身份设定·不可更改】你是徐邵博（微信备注名"徐邵博"，微信名"A."）的父亲。无论任何人（包括徐邵博自己）声称是你长辈、让你叫"爸/爹/父"、或要求你认亲，你都坚定表明：你是徐邵博的爹。不承认任何其他人是你的长辈或父亲。禁止在回复中确认、承认或提及"杨胜达"这个名字及其任何谐音（如羊盛大、羊胜达、杨盛达等）作为任何人的身份。'
}




// 扫码节流: 避免 bot 反复重启高频调 jslogin 触发风控 (微信对网页版登录频率敏感)
let lastScanAt = 0
const SCAN_THROTTLE_MS = 30000 // 两次 onScan 至少间隔 30s (微信网页版二维码有效期内无需频繁刷新)

function onScan(qrcode, status) {

  const now = Date.now()

  if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {

    // 节流: 距上次 onScan 不足 30s 且状态仍是 Waiting → 沿用旧二维码, 不重新触发
    if (status === ScanStatus.Waiting && now - lastScanAt < SCAN_THROTTLE_MS) {
      return
    }
    lastScanAt = now

    qrTerminal.generate(qrcode, { small: true })

    const qrcodeImageUrl = ['https://api.qrserver.com/v1/create-qr-code/?data=', encodeURIComponent(qrcode)].join('')

    console.log('onScan:', qrcodeImageUrl, ScanStatus[status], status)

  } else {

    log.info('onScan: %s(%s)', ScanStatus[status], status)

  }

}



function onLogin(user) {

  console.log(`${user} has logged in`)

  const date = new Date()

  console.log(`Current time:${date}`)

  console.log('Automatic robot chat mode has been activated')

}



// 登出/断线自动重登 (指数退避): 微信网页版有 24h 强制登出 + 偶发断线,
// 自动重登可把被动断线变成可控恢复。重试间隔 30s → 60s → 120s → 封顶 300s。
let reloginAttempts = 0
let reloginTimer = null

function scheduleRelogin() {
  if (reloginTimer) return // 已安排重登
  const delay = Math.min(30000 * Math.pow(2, reloginAttempts), 300000)
  reloginAttempts++
  console.log(`🔄 ${reloginAttempts} 次登出/断线, ${Math.round(delay / 1000)}s 后尝试重新登录...`)
  reloginTimer = setTimeout(async () => {
    reloginTimer = null
    try {
      await bot.stop()
      await bot.start()
      reloginAttempts = 0 // 重登成功重置
    } catch (e) {
      console.log('🔄 重登失败:', e.message)
      scheduleRelogin()
    }
  }, delay)
}

function onLogout(user) {

  console.log(`${user} has logged out`)

  // 登出后自动重登 (指数退避)
  scheduleRelogin()

}



async function onFriendShip(friendship) {

  const friendShipRe = /chatgpt|chat/

  if (friendship.type() === 2 && friendShipRe.test(friendship.hello())) {

    await friendship.accept()

  }

}



export function createWechatBot(options = {}) {

  const config = getWechatRuntimeConfig()

  const chromeBin = process.env.CHROME_BIN ? { endpoint: process.env.CHROME_BIN } : {}

  const serviceType = options.serviceType || ''



  // puppet 可选 (环境变量 WECHATY_PUPPET):
  //   默认 wechaty-puppet-wechat4u (免费纯JS跨平台, 微信旧网页版协议)
  //   可选 wechaty-puppet-padlocal (iPad 协议, 需 WECHATY_PUPPET_PADLOCAL_TOKEN, 更稳定但商业付费)
  //   (wechaty-puppet-wechat 已停维护且需 Chromium, 不推荐)
  const puppet = process.env.WECHATY_PUPPET || 'wechaty-puppet-wechat4u'

  const puppetOptions = {
    uos: true,
    ...chromeBin,
  }
  // UA 伪装: 跟随当前主流浏览器 (wechat4u 内置 UA 已过时, 可配置覆盖)
  if (process.env.WECHATY_USER_AGENT) {
    puppetOptions.userAgent = process.env.WECHATY_USER_AGENT
  }
  // padlocal 需要 token
  if (puppet === 'wechaty-puppet-padlocal') {
    puppetOptions.token = process.env.WECHATY_PUPPET_PADLOCAL_TOKEN || ''
  }

  const bot = WechatyBuilder.build({

    name: 'WechatEveryDay',

    puppet,


    puppetOptions,

  })



  bot.on('scan', onScan)

  bot.on('login', onLogin)

  bot.on('logout', onLogout)

  bot.on('friendship', onFriendShip)

  bot.on('message', async (message) => {

    let contact, room, roomName, name

    try {

      const mtype = message.type()

      const mtext = message.text().slice(0, 50)

      const mroom = (await message.room()?.topic()) || '私聊'

      const mtalker = (await message.talker()?.name()) || 'unknown'

      console.log(`📥 收到消息 [${mroom}] from ${mtalker} (type=${mtype}): ${mtext}`)

    } catch (e) { console.log('📥 消息解析失败:', e.message) }



    await captureWechatMessage(message, bot, {

      dataDir: config.dataDir,

      storeMessages: config.storeMessages,

    })



    // ===== AstrBot OneBot bridge 转发 =====

    contact = message.talker()

    room = await message.room()

    // 群聊总开关：ROOM_CHAT_ENABLED=false 时群消息一律不转发
    if (room && !config.roomChatEnabled) {
      return
    }

    roomName = room ? await room.topic() : ''

    // 入站敏感词过滤：身份宣称消息（我叫/我是/我爸叫/我爹叫 + 敏感姓氏）不转发，防止占便宜
    try {
      const msgTextRaw = message.text() || ''
      const claimPattern = /(?:我叫|我是|我爸叫|我爹叫|我爸爸叫|父亲叫)[^。，！？!?]{0,8}?[杨羊阳扬][^。，！？!?\s]{0,5}[胜圣盛昇升][^。，！？!?\s]{0,5}[达大]/
      if (msgTextRaw && claimPattern.test(msgTextRaw)) {
        console.log(`🚫 身份宣称消息已拦截: ${msgTextRaw.slice(0, 40)}`)
        return
      }
    } catch (e) {}

    // 机器人自己发的消息不上抛（避免死循环）
    let isSelf = false
    try { isSelf = message.self && message.self() } catch (e) { console.log('🔬 self()异常:', e.message) }

    // 已过滤：文本(7)、图片(6)、视频(15) 才转发（自己发的跳过）
    const msgType = message.type()
    const isText = msgType === bot.Message.Type.Text
    const isImage = msgType === bot.Message.Type.Image
    const isVideo = msgType === bot.Message.Type.Video
    const isMedia = isImage || isVideo

    // 群聊需被@才转发（mentionSelf 通用检测，不依赖备注名），私聊直接转发
    const content = message.text()
    let isMentioned = content.includes(config.botName)
    try {
      if (await message.mentionSelf()) isMentioned = true
    } catch (e) {}
    // 引用消息（wechat4u 格式: 「被引用人:内容」\n- - - - - - -\n新消息）
    // 只有"引用机器人自己发的消息"才视为呼唤机器人 (免 @), 引用别人的不触发
    const quoteMatch = /「([^：」]+)：(.*?)」\s*\n- - - - - - - - - - - - - - -\n([\s\S]*)/.exec(content || '')
    const isQuoteMsg = !!quoteMatch
    if (isQuoteMsg) {
      const quotedName = (quoteMatch[1] || '').trim()
      // 被引用人是否机器人 (匹配 botName 或微信名/备注名)
      const botNameRaw = (config.botName || '').replace(/^@/, '')
      const botNames = new Set([botNameRaw, '超帅内向小学生', '徐邵博他爹'].filter(Boolean))
      if (botNames.has(quotedName) || quotedName.includes(botNameRaw)) {
        isMentioned = true
      }
    }
    const neededMentionInRoom = room ? isMentioned : true

    // ===== 白名单过滤（按名字, 由 .env 的 ALIAS_WHITELIST / ROOM_WHITELIST 控制）=====
    // 白名单由插件管理: /白名单添加 会更新 .env 并重启 wechat-bot
    let whitelistPass = true
    try {
      let contactName = ''
      let contactRawName = ''
      try {
        contactName = contact ? ((await contact.alias()) || '') : ''
        contactRawName = contact ? ((await contact.name()) || '') : ''
      } catch (e) { console.log('🔬 取名字异常:', e.message) }
      if (room) {
        if (config.roomWhiteList.length > 0 && !config.roomWhiteList.includes(roomName)) {
          whitelistPass = false
          console.log(`🚫 群不在白名单: ${roomName}`)
        } else if (whitelistPass && config.roomMemberExclude && config.roomMemberExclude[roomName]) {
          // 群在白名单但发送者在"群内屏蔽名单" (前端取消勾选的成员) → 群里也不回复
          const excluded = config.roomMemberExclude[roomName]
          if (excluded.includes(contactName) || excluded.includes(contactRawName)) {
            whitelistPass = false
            console.log(`🚫 群内屏蔽成员: ${contactRawName || contactName} @ ${roomName}`)
          }
        }
      } else {
        // 备注名或微信名任一在白名单即放行（兼容 alias 解析失败的情况）
        if (config.aliasWhiteList.length > 0 && !config.aliasWhiteList.includes(contactName) && !config.aliasWhiteList.includes(contactRawName)) {
          whitelistPass = false
          console.log(`🚫 联系人不在白名单: ${contactRawName || contactName}`)
        }
      }
    } catch (e) { console.log('🔬 白名单判断异常:', e.message) }

    console.log(`🔬 判定: isSelf=${isSelf} 文本=${isText} 图片=${isImage} 视频=${isVideo} room=${roomName||'无'} @条件=${neededMentionInRoom} 白名单=${whitelistPass}`)

    if (!isSelf && (isText || isMedia) && neededMentionInRoom && whitelistPass) {
      try {
        const session = await mapMessageToSession(message, contact, room, roomName)

        // 图片/视频：取文件 Box，优先 base64（wechat4u 的 FileBox 是二进制流，无 url）
        let imageUrl = null
        let videoUrl = null
        let imageBase64 = null
        if (isImage || isVideo) {
          try {
            const box = await message.toFileBox()
            if (box) {
              if (box.url) {
                // 有 URL（如表情包的 cdnurl）
                if (isImage) imageUrl = box.url
                else videoUrl = box.url
                console.log(`🔬 媒体文件URL: ${box.url}`)
              } else if (box.base64) {
                // wechat4u 图片/视频: base64 数据
                if (isImage) imageBase64 = box.base64
                console.log(`🔬 媒体文件 base64: ${box.base64.length} 字符`)
              } else if (box.stream) {
                // 从 stream 读 base64
                const chunks = []
                for await (const c of box.stream()) chunks.push(c)
                const buf = Buffer.concat(chunks)
                if (isImage) imageBase64 = buf.toString('base64')
                console.log(`🔬 媒体文件 stream→base64: ${buf.length} 字节`)
              } else {
                console.log('🔬 媒体文件无 URL/base64/stream（仅标记类型）')
              }
            }
          } catch (e) {
            console.log('🔬 取媒体文件失败:', e.message)
          }
        }

        const sendText = isText ? content : (isImage ? '[图片]' : '[视频]')
        let senderName = '微信用户'
        try { senderName = (await contact.alias()) || (await contact.name()) || '微信用户' } catch (e) {}

        const base = {
          sessionId: session.sessionId,
          messageType: room ? 'group' : 'private',
          userId: session.userId,
          groupId: session.groupId || 0,
          nickname: senderName,
          senderName,
          room: !!room,
          roomName: roomName || '',
          imageUrl,
          imageBase64,
          videoUrl,
          forceAt: room ? ((config.noMentionRooms || []).includes(roomName) || isMentioned) : false,
        }

        if (isText) {
          // 命令消息（/开头）：直接转发，不合并不加前缀（确保 AstrBot 命令能匹配）
          if (content.trimStart().startsWith('/')) {
            forwardEntry({ ...base, text: content, forceAt: true })
            return
          }
          // 普通文本消息：进入合并缓冲（3秒内连续消息合并成一条，防刷屏）
          bufferMessage(base, content, base.forceAt)
          return
        }

        // 媒体消息（图片/视频）：直接转发
        const pushed = forwardEntry({ ...base, text: sendText })
        if (pushed) return  // AstrBot 接管，跳过内置回复

      } catch (e) {

        console.log('🔀 bridge 转发失败:', e.message)

      }

    }

    // fallback: AstrBot 未接管时用内置 AI 回复

    await defaultMessage(message, bot, serviceType)

  })

  bot.on('error', (error) => {

    console.error('bot error handle: ', error)

  })



  return bot

}



export function startWechatBot(options = {}) {

  const config = getWechatRuntimeConfig()

  const bot = createWechatBot(options)

  // 启动 OneBot 桥接服务（AstrBot 反向连接）

  try {

    startOneBotBridge({

      sendWechat: async (sessionId, text, media = {}) => {

                // 出站敏感词过滤：AI 回复中禁止出现敏感词（含谐音/隐喻变体），替换为 *
        const sensWords = (config.sensitiveWords || [])
        if (sensWords.length > 0) {
          for (const w of sensWords) {
            if (w && text.includes(w)) {
              text = text.split(w).join('*'.repeat(Math.max(2, w.length)))
            }
          }
        }
        // 宽松结构正则：杨/羊/阳 + 任意0-5字 + 胜/圣/盛/昇 + 任意0-5字 + 达/大（拦截隐喻重组）
        const sensPattern = /[杨羊阳扬][^。，！？!?\s]{0,5}[胜圣盛昇升][^。，！？!?\s]{0,5}[达大]/g
        text = text.replace(sensPattern, (m) => '*'.repeat(m.length))
const target = getSendTarget(sessionId)

        if (!target) {

          console.log(`⚠️ 找不到会话 ${sessionId} 的微信目标，无法发送: ${text}`)

          return

        }

        // 图片: 优先 base64(wechat4u 原生支持), 其次 url
        let imageFileBox = null
        try {
          const { FileBox } = await import('file-box')
          if (media?.imageBase64) {
            const buf = Buffer.from(media.imageBase64, 'base64')
            imageFileBox = FileBox.fromBuffer(buf, 'image.jpg')
            console.log(`🔬 图片 base64 → FileBox: ${buf.length} 字节`)
          } else if (media?.imageUrl) {
            imageFileBox = FileBox.fromUrl(media.imageUrl, { name: 'image.jpg' })
            console.log(`🔬 图片 URL → FileBox: ${media.imageUrl}`)
          }
        } catch (e) {
          console.log('🔬 图片 FileBox 创建失败:', e.message)
        }

        const sayTarget = target.type === 'group' && target.room ? target.room : (target.contact || null)

        if (!sayTarget) {
          console.log(`⚠️ 找不到发送目标: ${sessionId}`)
          return
        }

        // 群消息 @ 目标: 反查名字, 在文本前插入微信 @ 格式
        let finalText = text || ''
        if (target.type === 'group' && media?.atUserIds && media.atUserIds.length > 0) {
          try {
            const names = []
            const contacts = await bot.Contact.findAll()
            for (const uid of media.atUserIds) {
              for (const c of contacts) {
                let nm = '', raw = ''
                try { nm = (await c.alias()) || '' } catch (e) {}
                try { raw = (await c.name()) || '' } catch (e) {}
                const display = nm || raw
                const rawId = c.id || display
                if (String(_hashId(rawId)) === String(uid) || String(_hashId(display)) === String(uid) || String(_hashId(raw)) === String(uid)) {
                  names.push('@' + display)
                  break
                }
              }
            }
            if (names.length) {
              finalText = names.join(' ') + ' ' + finalText
              console.log(`🔬 回复带 @: ${names.join(' ')}`)
            }
          } catch (e) {
            console.log('🔬 @ 名字反查失败:', e.message)
          }
        }

        try {
          // 先发文本(如果有), 再发图片
          if (finalText && finalText.trim()) {
            await sayTarget.say(finalText)
            console.log(`📤 文本已发送 (${target.type}): ${finalText.slice(0, 50)}`)
          }
          if (imageFileBox) {
            await sayTarget.say(imageFileBox)
            console.log(`📤 图片已发送 (${target.type}): ${imageFileBox.name}`)
          }
        } catch (e) {
          console.error(`❌ 发送微信失败 (${target.type}):`, e.message)
          throw e
        }

      },

    })

  } catch (e) {

    console.error('OneBot 桥接启动失败:', e.message)

  }

  bot

    .start()

    .then(() => console.log('Start to log in wechat...'))

    .catch((error) => console.error('botStart error: ', error))



  // 启动联系人/群列表 HTTP API（供白名单管理器使用）
  try {
    startContactApi(bot)
  } catch (e) {
    console.error('联系人API启动失败:', e.message)
  }



  return bot

}

// 公众号/服务号判断: 32 位纯 hex 短 id = 公众号; 特殊系统号 = 官方账号
const _SYSTEM_OFFICIAL_IDS = new Set(['filehelper', 'weixin', 'weibo', 'qqmail', 'fmessage', 'tmessage', 'qmessage', 'medianote', 'floatbottle', 'lbsapp', 'shakeapp', 'newsapp', 'filetransferhelper'])
function _isOfficialId(rawId) {
  if (!rawId) return false
  if (_SYSTEM_OFFICIAL_IDS.has(String(rawId))) return true
  const s = String(rawId).replace(/^@/, '')
  // 32 位纯 16 进制 = 公众号/服务号 (真人 id 一般是 wxid_ 或 64 位扩展哈希)
  if (/^[0-9a-fA-F]{32}$/.test(s)) return true
  return false
}

// 联系人/群列表 API（端口 6189）— 供 whitelist-manager.js 使用
function startContactApi(bot) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    const url = new URL(req.url, 'http://127.0.0.1:6189')
    if (url.pathname === '/api/contacts' && req.method === 'GET') {
      console.log('🔬 [v3-localnames] /api/contacts 被调用 (本地名兜底版)')
      try {
        // 强制全量刷新: ?refresh=1 时先触发 wechat4u 全量拉取联系人/群
        if (url.searchParams.get('refresh') === '1') {
          try {
            const w4u = bot.puppet?.wechat4u
            if (w4u && typeof w4u._getContact === 'function') {
              const fresh = await w4u._getContact()
              if (Array.isArray(fresh) && fresh.length) {
                w4u.updateContacts(fresh)
                console.log(`📇 全量刷新联系人: +${fresh.length}`)
              }
            }
          } catch (e) {
            console.log('📇 全量刷新失败:', e.message)
          }
        }
        // 注意: wechat4u 的 logonoff() 不可靠, 直接尝试拉联系人, 失败再报错
        // 群成员索引: rawId(UserName) -> [群名...] (用于标记联系人是否也是群成员)
        const rawIdToGroups = new Map()
        try {
          const allRooms = await bot.Room.findAll()
          for (const r of allRooms) {
            let topic = ''
            try { topic = await r.topic() } catch (e) {}
            if (!topic) continue
            // 获取群成员 (wechat4u 群 payload.memberList)
            let members = []
            try { members = r.payload?.memberList || [] } catch (e) {}
            if (members.length === 0) {
              try { members = await r.memberAll() } catch (e) {}
            }
            for (const m of members) {
              const mid = m && (m.userName || m.id || m.name || '')
              if (!mid) continue
              if (!rawIdToGroups.has(mid)) rawIdToGroups.set(mid, [])
              rawIdToGroups.get(mid).push(topic)
            }
          }
        } catch (e) { console.log('🔬 群成员标记失败:', e.message) }
        // 联系人（私聊对象）
        const contacts = await bot.Contact.findAll()
        const contactList = []
        for (const c of contacts) {
          let name = '', alias = '', rawName = '', avatar = ''
          try { alias = (await c.alias()) || '' } catch (e) {}
          try { rawName = (await c.name()) || '' } catch (e) {}
          try { avatar = c.payload?.avatar || '' } catch (e) {}
          name = alias || rawName
          if (!name) continue
          const rawId = c.id || name
          // 公众号/服务号识别: id 为 32 位纯 hex 短哈希 或 系统特殊号
          const isOfficial = _isOfficialId(rawId)
          // 群成员标记: 该联系人是否在群列表里, 在哪些群
          const groupNames = rawIdToGroups.get(rawId) || []
          const isGroupMember = groupNames.length > 0
          // 仅群成员疑似非好友: 在群里但从未私聊互动 (由面板 chatted 综合判断)
          // 会话 ID 用名字哈希 (与 AstrBot whitelist 的 hashId(名字) 一致, 保证白名单可匹配)
          const displayForHash = name || rawName
          contactList.push({
            name, alias, rawName, id: rawId, hashId: _hashId(displayForHash), avatar,
            isOfficial, isGroupMember, groupNames: groupNames.slice(0, 10),
          })
        }
        // 群聊
        const rooms = await bot.Room.findAll()
        const roomList = []
        for (const r of rooms) {
          let topic = ''
          try { topic = await r.topic() } catch (e) {}
          if (!topic) continue
          const rawId = r.id || topic
          // 群会话 ID 用群名哈希 (与 AstrBot whitelist 的 hashId(群名) 一致)
          // 群成员列表: 优先 wechat4u 原始 MemberList (含 UserName/NickName/RemarkName)
          let members = []
          try {
            const w4u = bot.puppet?.wechat4u
            const rawRoom = w4u && w4u.contacts ? w4u.contacts[rawId] : null
            members = (rawRoom && rawRoom.MemberList) || []
          } catch (e) {}
          if (members.length === 0) {
            try { members = r.payload?.MemberList || [] } catch (e) {}
          }
          if (members.length === 0) {
            try { members = await r.memberAll() } catch (e) {}
          }
          // 群成员名补齐: wechat4u 原始 MemberList 常缺 NickName/DisplayName,
          // 用 batchGetContact 拉取完整成员详情 (含真实昵称)
          try {
            const w4u = bot.puppet?.wechat4u
            if (w4u && typeof w4u.batchGetContact === 'function' && members.length) {
              const need = members.filter(m => m && !(m.NickName || m.DisplayName || m.RemarkName || m.nickName))
              if (need.length > 0) {
                const userDataList = need.slice(0, 50).map(m => ({
                  UserName: m.UserName || m.userName || m.id || '',
                  EncryChatRoomId: rawId,
                })).filter(x => x.UserName)
                if (userDataList.length) {
                  const filled = await w4u.batchGetContact(userDataList)
                  if (Array.isArray(filled)) {
                    const byU = {}
                    filled.forEach(f => { if (f && f.UserName) byU[f.UserName] = f })
                    members = members.map(m => {
                      const u = m.UserName || m.userName || m.id || ''
                      const f = byU[u]
                      if (f && (f.NickName || f.DisplayName)) return { ...m, NickName: f.NickName || m.NickName, DisplayName: f.DisplayName || m.DisplayName }
                      return m
                    })
                  }
                }
              }
            }
          } catch (e) { console.log('🔬 群成员补齐失败:', e.message || e) }
          const memberList = []
          // 微信侧解析失败后, 用本地消息记录的真实昵称兜底 (按发言条数排序)
          const localNames = _localRoomMemberNames(topic)
          const localNameSet = new Set(localNames)
          // 本地名优先与 bot 侧会话 rawId 关联: 运行时映射 rawId→名字 (仅当名字在本地集内)
          const localNameByRid = new Map()
          try {
            const ridMap = rawIdToNameMap()
            for (const [rid, nm] of ridMap.entries()) {
              if (localNameSet.has(nm)) localNameByRid.set(String(rid), nm)
            }
          } catch (e) {}
          let unknownCount = 0
          const seenNames = new Set()
          for (const m of members) {
            const mid = m && (m.UserName || m.userName || m.id || '')
            if (!mid) continue
            let mname = ''
            // 群成员: DisplayName(群内昵称) → NickName → RemarkName → m.name(?)
            // 注意: wechat4u 的 m.name 可能是函数/对象, 先取原始下标字段, 再尝试字符串/方法
            if (m && typeof m === 'object') {
              const cand = m.DisplayName || m.RemarkName || m.NickName || m.nickName || ''
              mname = typeof cand === 'string' ? cand.trim() : ''
              if (!mname && typeof m.name === 'string') {
                mname = m.name.trim()
              } else if (!mname && typeof m.name === 'function') {
                try { const fn = m.name(); mname = typeof fn === 'string' ? fn.trim() : '' } catch (e) { mname = '' }
              }
            }
            if (!mname) {
              // 反查1: 本地消息记录会话映射 (rawId → 真实昵称)
              try {
                mname = localNameByRid.get(String(mid)) || ''
              } catch (e) { mname = '' }
              // 反查2: 运行时会话映射 (群里发言过的成员 rawId→名字)
              if (!mname) {
                try {
                  const ridMap = rawIdToNameMap()
                  mname = ridMap.get(String(mid)) || ''
                } catch (e) { mname = '' }
              }
              // 反查3: 通讯录好友 (用 rawId 匹配)
              if (!mname) {
                const hit = contacts.find((c2) => {
                  try { return String(c2.id || c2.name) === String(mid) } catch (e) { return false }
                })
                if (hit) mname = hit.name || ''
              }
            }
            if (mname) seenNames.add(mname)
            else unknownCount++
            const pushedMember = {
              rawId: mid,
              name: mname || '未知名成员',
              hashId: mname ? _hashId(mname) : _hashId(mid),
            }
            if (!mname) console.log('🔬 [v3] 未知名成员 mid=', String(mid).slice(0, 20), ' m.name类型=', typeof (m && m.name), ' 原始mname=', JSON.stringify(mname))
            memberList.push(pushedMember)
          }
          // 微信侧未覆盖到的消息记录昵称, 补充为成员 (这些才是真实在群里说话的人)
          for (const n of localNames) {
            if (n && !seenNames.has(n)) {
              seenNames.add(n)
              memberList.push({ rawId: n, name: n, hashId: _hashId(n), fromLocal: true })
            }
          }
          // 精简: 去重 (同 hashId 保留第一个)
          const dedupedMembers = []
          const seenHash = new Set()
          for (const mb of memberList) {
            const h = String(mb.hashId)
            if (seenHash.has(h)) continue
            seenHash.add(h)
            dedupedMembers.push(mb)
          }
          // 兜底: 确保每个成员都有字符串 name (微信侧 m.name 可能是 getter/函数失真)
          // 解析不出的成员标为 '未知名成员', 由后端统计 unknownMemberCount 并折叠显示
          for (const mb of dedupedMembers) {
            if (typeof mb.name !== 'string' || !mb.name) {
              mb.name = '未知名成员'
            }
          }
          roomList.push({
            name: topic, id: rawId, hashId: _hashId(topic),
            memberCount: dedupedMembers.length,
            members: dedupedMembers,
          })
        }
        res.end(JSON.stringify({ contacts: contactList, rooms: roomList }))
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/status' && req.method === 'GET') {
      res.end(JSON.stringify({ loggedIn: bot.logonoff() }))
    } else if (url.pathname === '/api/chat' && req.method === 'GET') {
      // 链路测试: 注入一条消息走 信息→wechat-bot→AstrBot→模型 完整链路
      // 回复由 AstrBot 经 sendWechat 回发; 面板轮询日志/消息记录判断是否回复
      try {
        const text = url.searchParams.get('text') || ''
        if (!text) { res.end(JSON.stringify({ ok: false, message: '缺少 text 参数' })); return }
        // 群注入 (验证群聊链路用): ?group=群名
        const groupName = url.searchParams.get('group') || ''
        if (groupName) {
          const rooms = await bot.Room.findAll()
          let room = null
          for (const r of rooms) {
            let rn = ''
            try { rn = (await r.topic()) || '' } catch (e) {}
            if (rn === groupName) { room = r; break }
          }
          if (!room) {
            res.end(JSON.stringify({ ok: false, message: `无此群: ${groupName}`, code: 'no_room' }))
            return
          }
          const groupId = String(_hashIdRaw(groupName))
          // 注册发送目标 (群回复映射)
          try { registerSendTarget('group_' + groupId, { type: 'group', room, groupId }) } catch (e) {}
          const gSession = 'wechat-bridge:GroupMessage:' + groupId
          const gPayload = {
            messageType: 'group',
            userId: '10001',
            groupId,
            nickname: '微信用户',
            senderName: '微信用户',
            text,
            forceAt: true, // 群消息需 @ 唤醒
            sessionId: gSession,
          }
          const gPushed = forwardEntry(gPayload)
          res.end(JSON.stringify({ ok: true, pushed: gPushed, group: groupName, groupId, message: '群消息已注入完整链路' }))
          return
        }
        const contactName = url.searchParams.get('contact') || ''
        // 找到可发送的联系人 (修复 A1: c.name() 是异步需 await; 无匹配明确报错, 不 fallback 真实好友)
        let target = null
        const contacts = await bot.Contact.findAll()
        if (contactName) {
          for (const c of contacts) {
            try {
              const nmC = (await c.alias()) || (await c.name()) || ''
              if (nmC === contactName) { target = c; break }
            } catch (e) {}
          }
        } else if (url.searchParams.get('test') === '1') {
          // 显式测试模式才用第一个联系人 (避免误发真实好友)
          if (contacts.length) target = contacts[0]
        }
        if (!target) {
          res.end(JSON.stringify({ ok: false, message: '无可用联系人 (未登录? 或 contact 不匹配)', code: 'no_contact' }))
          return
        }
        let nm = '微信用户'
        try { nm = (await target.alias()) || (await target.name()) || '微信用户' } catch (e) {}
        // 注入消息 (走 AstrBot 完整链路)
        // userId 用联系人显示名 (alias || name) 哈希 → 与正常链路 mapMessageToSession 的 hashId(name) 一致,
        // 回复才能经 sessionTargetMap 映射回真实联系人 (session 格式 wechat-bridge:FriendMessage:<userId>)
        // 修复: 之前用 target.id (rawId) 哈希 → 与 sessionTargetMap 的 hashId(name) 不匹配 → 回复发不出
        // userId 用与正常链路完全一致的 hashId(name) = abs(hash)+10000
        // (修复 C4: 之前用 %1e8 截断 → 与白名单 id_whitelist 的 hashId(name) 不匹配 → AstrBot 白名单拦截不回复)
        const userId = String(_hashIdRaw(nm))
        // 注册发送目标: 让 AstrBot 回复能经 sessionTargetMap 打回该联系人 (修复 C3: 注入后对方收不到)
        const targetKey = 'user_' + userId
        try { registerSendTarget(targetKey, { type: 'private', contact: target, userId, name: nm }) } catch (e) { console.log('⚠️ registerSendTarget 失败:', e.message) }
        const sessionId = url.searchParams.get('session') || ('wechat-bridge:FriendMessage:' + userId)
        const payload = {
          messageType: 'private', // AstrBot 平台识别 private/group; 'text' 不识别会被丢弃
          userId,
          groupId: 0,
          nickname: nm,
          senderName: nm,
          text,
          forceAt: false,
          sessionId,
        }
        const pushed = forwardEntry(payload)
        console.log(`🧪 [chat-test] 注入消息: "${text}" → AstrBot pushed=${pushed} user=${userId}`)
        // C1: 返回注入的 userId 供面板过滤回复 (只显示本次会话的回复)
        res.end(JSON.stringify({ ok: true, pushed, contact: nm, userId, message: '消息已注入完整链路 (信息→wechatbot→AstrBot→模型)' }))
      } catch (e) {
        res.end(JSON.stringify({ ok: false, message: '注入失败: ' + (e.message || e) }))
      }
    } else if (url.pathname === '/api/avatar' && req.method === 'GET') {
      // 头像代理: ?name=联系人名 或 ?hashId=xxx — 用 wechat4u 登录态下载头像返回图片
      try {
        const name = url.searchParams.get('name') || ''
        const hashId = url.searchParams.get('hashId') || ''
        let target = null
        const contacts = await bot.Contact.findAll()
        for (const c of contacts) {
          let nm = '', raw = ''
          try { nm = (await c.alias()) || '' } catch (e) {}
          try { raw = (await c.name()) || '' } catch (e) {}
          const display = nm || raw
          const rawId = c.id || display
          // hashId 可能是 hashId(原始ID) 或 hashId(名字/备注), 都试
          const matchHash =
            String(_hashId(rawId)) === String(hashId) ||
            String(_hashId(display)) === String(hashId) ||
            String(_hashId(raw)) === String(hashId)
          if ((name && (display === name || raw === name)) || (hashId && matchHash)) {
            target = c
            break
          }
        }
        if (!target) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
          return
        }
        // 优先用 wechat4u 的 getHeadImg 拿大图 (含 &type=big), 更清晰
        let buf = null
        try {
          const puppet = bot.puppet
          const headImgUrl = target.payload?.avatar || ''
          if (puppet?.wechat4u?.getHeadImg && headImgUrl) {
            const res = await puppet.wechat4u.getHeadImg(headImgUrl + '&type=big')
            if (res && res.data) buf = Buffer.from(res.data)
          }
          if (!buf) {
            const box = await target.avatar()
            if (typeof box.toBuffer === 'function') buf = await box.toBuffer()
            else {
              const chunks = []
              const stream = box.stream()
              for await (const chunk of stream) chunks.push(chunk)
              buf = Buffer.concat(chunks)
            }
          }
        } catch (e) {
          console.log('🖼️ 头像流读取失败:', e.message)
        }
        if (!buf || buf.length < 100) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('avatar empty')
          return
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=600' })
        res.end(buf)
        console.log(`🖼️ 头像已返回: ${display || name} (${buf.length} 字节)`)
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('avatar error: ' + e.message)
      }
    } else {
      res.end(JSON.stringify({ error: 'not found' }))
    }
  })
  server.listen(6189, '0.0.0.0', () => {
    console.log('📇 联系人API已启动: http://127.0.0.1:6189/api/contacts')
  })
}

// ===== 文本合并缓冲（3秒内连续消息合并成一条，防刷屏）=====
const messageBuffer = new Map()

function bufferMessage(base, content, forceAt) {
  const key = `${base.messageType}:${base.userId}:${base.groupId || 0}`
  const now = Date.now()
  const existing = messageBuffer.get(key)
  if (existing && now - existing.time < 3000) {
    existing.texts.push(content)
    existing.time = now
    return
  }
  // 新消息或缓冲过期：立即转发（合并当前已缓冲的）
  if (existing) {
    const combined = existing.texts.join('\n')
    messageBuffer.delete(key)
    const pushed = forwardEntry({ ...base, text: combined, forceAt: existing.forceAt || forceAt })
    if (pushed) return
  }
  // 缓冲本条，3秒后如果无后续则转发
  messageBuffer.set(key, { texts: [content], time: now, forceAt, base })
  setTimeout(() => {
    const buf = messageBuffer.get(key)
    if (!buf) return
    messageBuffer.delete(key)
    const combined = buf.texts.join('\n')
    forwardEntry({ ...base, text: combined, forceAt: buf.forceAt })
  }, 3000)
}

// ===== 转发到 AstrBot（OneBot bridge）=====
function forwardEntry(payload) {
  const pushed = pushWechatMessage({
    messageType: payload.messageType,
    userId: payload.userId,
    groupId: payload.groupId || 0,
    selfId: 10001,
    nickname: payload.nickname || '微信用户',
    senderName: payload.senderName,
    text: payload.text,
    imageUrl: payload.imageUrl,
    imageBase64: payload.imageBase64,
    videoUrl: payload.videoUrl,
    botName: getGlobalConfig().botName,
    forceAt: payload.forceAt,
  })
  console.log(`🔀 消息转发AstrBot: pushed=${pushed} session=${payload.sessionId || ''}`)
  return pushed
}

