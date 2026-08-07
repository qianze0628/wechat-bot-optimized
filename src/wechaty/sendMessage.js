import { getServe } from './serve.js'
import { getWechatRuntimeConfig } from '../config/env.js'
import { handleWechatCommand } from '../platforms/wechat/commandRouter.js'
import { getSessionKey, remember, getHistory, clearHistory } from './memory.js'
import { formatRoomContext, listRooms } from './groupinfo.js'
import { TOOLS, executeTool } from './tools.js'
import { loadPlugins, collectPluginTools, executePluginTool, handlePluginCommands, startCronTasks, dispatchMessage, getPluginsInfo } from './plugin-loader.js'

// 模块级缓存：插件列表（启动时加载一次）
let _plugins = null
let _cronStarted = false
async function getPlugins(bot = null) {
  if (!_plugins) {
    // 传入 bot 上下文（插件可用 ctx.bot 发消息）
    const botContext = bot ? { bot, say: async (contact, text) => { try { await contact.say(text) } catch (e) { console.error('插件say失败:', e.message) } } } : {}
    _plugins = await loadPlugins(botContext)
  }
  // 启动定时任务（只启动一次）
  if (!_cronStarted && _plugins.length) {
    startCronTasks(_plugins)
    _cronStarted = true
  }
  return _plugins
}

/**
 * 默认消息发送（增强版：记忆 + 群信息 + 工具调用）
 * @param msg
 * @param bot
 * @param ServiceType 服务类型 'GPT' | 'Kimi'
 * @returns {Promise<void>}
 */
export async function defaultMessage(msg, bot, ServiceType = 'GPT') {
  // 加载插件（首次调用时）
  const plugins = await getPlugins(bot)
  const pluginTools = collectPluginTools(plugins)
  const allTools = [...TOOLS, ...pluginTools] // 内置工具 + 插件工具
  const { botName, autoReplyPrefix, aliasWhiteList, roomWhiteList, commandPrefix } = getWechatRuntimeConfig()
  const getReply = getServe(ServiceType)
  const contact = msg.talker() // 发消息人
  const receiver = msg.to() // 消息接收人
  const content = msg.text() // 消息内容
  const room = msg.room() // 是否是群消息
  const roomName = (await room?.topic()) || null // 群名称
  const alias = (await contact.alias()) || (await contact.name()) // 发消息人昵称
  const remarkName = await contact.alias() // 备注名称
  const name = await contact.name() // 微信名称
  const isText = msg.type() === bot.Message.Type.Text // 消息类型是否为文本
  const isRoom = (roomWhiteList.length === 0 || roomWhiteList.includes(roomName)) && content.includes(`${botName}`) // 群白名单为空=全部群（需@机器人）
  const isAlias = aliasWhiteList.length === 0 || aliasWhiteList.includes(remarkName) || aliasWhiteList.includes(name) // 白名单为空=全部回复
  const isBotSelf = botName === `@${remarkName}` || botName === `@${name}` // 是否是机器人自己
  const isBotSelfDebug = content.trimStart().startsWith('你是谁') // 是否是机器人自己的调试消息
  const isAuthorizedCommand = (room && isRoom) || (!room && isAlias)
  // 会话 key（记忆用）
  const sessionKey = getSessionKey(!!room, roomName || '', name || '')

  // 消息监听器分发（插件可拦截消息直接回复，如"你叫什么"）
  try {
    const listenerReply = await dispatchMessage(plugins, msg, { roomName, isRoom: !!room })
    if (listenerReply) {
      await (room || contact).say(listenerReply)
      return
    }
  } catch (e) { console.error('消息监听分发失败:', e.message) }
  // TODO 你们可以根据自己的需求修改这里的逻辑
  if ((isBotSelf && !isBotSelfDebug) || !isText) return // 如果是机器人自己发送的消息或者消息类型不是文本则不处理
  try {
    // 命令处理（/分析 /统计 /清空记忆 /群列表 等）
    if (content.replace(`${botName}`, '').trimStart().startsWith(commandPrefix)) {
      if (!isAuthorizedCommand) return
      // 自定义命令：/清空记忆
      const cmdText = content.replace(`${botName}`, '').trim()
      if (cmdText.startsWith('/清空') || cmdText.startsWith('/clear')) {
        clearHistory(sessionKey)
        await (room || contact).say('✅ 记忆已清空')
        return
      }
      // 自定义命令：/群列表
      if (cmdText.startsWith('/群列表') || cmdText.startsWith('/rooms')) {
        const rooms = listRooms()
        const reply = rooms.length
          ? `📋 群列表：\n${rooms.map((r) => `${r.name}（${r.count}条消息）`).join('\n')}`
          : '暂无群聊记录'
        await (room || contact).say(reply)
        return
      }
      // 插件管理命令：/插件 查看所有插件
      if (cmdText.startsWith('/插件') || cmdText.startsWith('/plugins')) {
        const info = getPluginsInfo(plugins)
        if (!info.length) {
          await (room || contact).say('📦 暂无插件，把 .js 文件放进 plugins/ 目录即可加载')
          return
        }
        const lines = info.map((p) => {
          const parts = [`📦 ${p.name}`]
          if (p.description) parts.push(`   ${p.description}`)
          if (p.tools.length) parts.push(`   工具: ${p.tools.join(', ')}`)
          if (p.commands.length) parts.push(`   命令: ${p.commands.join(', ')}`)
          if (p.cron.length) parts.push(`   定时: ${p.cron.join(', ')}`)
          return parts.join('\n')
        })
        await (room || contact).say(`📦 已加载 ${info.length} 个插件：\n\n` + lines.join('\n\n'))
        return
      }
      // 插件命令处理（/基金 /热榜 /搜图 等）
      if (cmdText.startsWith(commandPrefix)) {
        const cmdParts = cmdText.slice(1).split(/\s+/)
        const cmdName = cmdParts[0]
        const cmdArgs = cmdParts.slice(1).join(' ')
        const pluginReply = await handlePluginCommands(plugins, cmdName, cmdArgs, { roomName, alias, name })
        if (pluginReply) {
          await (room || contact).say(pluginReply)
          return
        }
      }
      const commandResult = await handleWechatCommand(content, {
        serviceType: ServiceType,
        roomName,
        alias,
        name,
      })
      if (commandResult.handled) {
        if (commandResult.reply) {
          await (room || contact).say(commandResult.reply)
        }
        return
      }
    }

    // 区分群聊和私聊
    // 群聊消息去掉艾特主体后，匹配自动回复前缀
    if (isRoom && room && content.replace(`${botName}`, '').trimStart().startsWith(`${autoReplyPrefix}`)) {
      const question = (await msg.mentionText()) || content.replace(`${botName}`, '').replace(`${autoReplyPrefix}`, '') // 去掉艾特的消息主体
      console.log('🌸🌸🌸 / question: ', question)

      // 构造增强上下文：历史记忆 + 群信息 + 工具调用
      const history = getHistory(sessionKey)
      let systemExtra = ''
      // 群聊时附带群信息上下文
      if (roomName) {
        try { systemExtra += '\n\n' + formatRoomContext(roomName, 10) } catch (e) {}
      }
      const system = `你是一个微信AI助手，正在群里与用户聊天。\n请用简洁自然的中文回复，不要用markdown格式。\n${systemExtra}`
      // 记忆历史转成消息数组
      const historyMessages = history
        ? history.split('\n').filter(Boolean).slice(-20).map((line) => {
            const [role, ...rest] = line.split('：')
            return { role: role === 'AI' ? 'assistant' : 'user', content: rest.join('：') }
          })
        : []

      const response = await getReply(question, {
        system,
        history: historyMessages,
        tools: allTools,
        toolExecutor: async (name, args) => {
          const pluginResult = await executePluginTool(plugins, name, args)
          if (pluginResult) return pluginResult
          return executeTool(name, args)
        },
      })
      await room.say(response)
      // 记录记忆
      remember(sessionKey, question, response)
    }
    // 私人聊天，白名单内的直接发送
    // 私人聊天直接匹配自动回复前缀
    if (isAlias && !room && content.trimStart().startsWith(`${autoReplyPrefix}`)) {
      const question = content.replace(`${autoReplyPrefix}`, '')
      console.log('🌸🌸🌸 / content: ', question)

      // 构造增强上下文：历史记忆 + 工具调用
      const history = getHistory(sessionKey)
      const system = `你是一个微信AI助手，正在与用户私聊。\n请用简洁自然的中文回复，不要用markdown格式。`
      const historyMessages = history
        ? history.split('\n').filter(Boolean).slice(-20).map((line) => {
            const [role, ...rest] = line.split('：')
            return { role: role === 'AI' ? 'assistant' : 'user', content: rest.join('：') }
          })
        : []

      const response = await getReply(question, {
        system,
        history: historyMessages,
        tools: allTools,
        toolExecutor: async (name, args) => {
          const pluginResult = await executePluginTool(plugins, name, args)
          if (pluginResult) return pluginResult
          return executeTool(name, args)
        },
      })
      await contact.say(response)
      // 记录记忆
      remember(sessionKey, question, response)
    }
  } catch (e) {
    console.error(e)
  }
}
