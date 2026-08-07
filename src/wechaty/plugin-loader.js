// 轻量插件加载器 v2 - 支持定时任务、事件监听、插件管理
import fs from 'fs'
import path from 'path'

const PLUGIN_DIR = path.join(process.cwd(), 'plugins')

/**
 * 加载所有插件
 * @param {object} botContext { bot: wechaty bot 实例, say: 发消息函数 }
 * @returns {Array} 插件列表
 */
export async function loadPlugins(botContext = {}) {
  const plugins = []
  try {
    if (!fs.existsSync(PLUGIN_DIR)) {
      fs.mkdirSync(PLUGIN_DIR, { recursive: true })
      return plugins
    }
    const files = fs.readdirSync(PLUGIN_DIR).filter((f) => f.endsWith('.js'))
    for (const file of files) {
      try {
        const module = await import(path.join('file://', PLUGIN_DIR, file))
        const plugin = module.default || module
        if (plugin && plugin.name) {
          plugins.push({
            file,
            name: plugin.name,
            description: plugin.description || '',
            tools: plugin.tools || [],                    // 插件注册的工具
            commandHandlers: plugin.commandHandlers || [], // 插件注册的命令
            cronTasks: plugin.cronTasks || [],            // 插件注册的定时任务
            messageListeners: plugin.messageListeners || [], // 插件注册的消息监听
            onLoad: plugin.onLoad || null,                // 插件加载时的钩子
            _context: botContext,                         // 机器人上下文（bot、say 等）
          })
          console.log(`🧩 插件已加载: ${plugin.name} (${file})`)
          // 执行插件的 onLoad 钩子
          if (plugin.onLoad) {
            try {
              await plugin.onLoad(botContext)
            } catch (e) {
              console.error(`❌ 插件 ${plugin.name} onLoad 失败:`, e.message)
            }
          }
        }
      } catch (e) {
        console.error(`❌ 插件加载失败 ${file}:`, e.message)
      }
    }
  } catch (e) {
    console.error('插件目录扫描失败:', e.message)
  }
  return plugins
}

/**
 * 聚合所有插件的工具定义（给 AI 的 tools 参数）
 */
export function collectPluginTools(plugins) {
  const tools = []
  for (const plugin of plugins) {
    if (plugin.tools && plugin.tools.length) {
      tools.push(...plugin.tools.map((t) => t.definition))
    }
  }
  return tools
}

/**
 * 执行插件工具
 */
export async function executePluginTool(plugins, name, args) {
  for (const plugin of plugins) {
    for (const tool of plugin.tools || []) {
      if (tool.definition.function.name === name) {
        try {
          console.log(`🧩 插件工具调用: ${plugin.name}/${name}`, JSON.stringify(args))
          return await tool.execute(args, plugin._context)
        } catch (e) {
          return `插件工具执行错误: ${e.message}`
        }
      }
    }
  }
  return null
}

/**
 * 处理插件命令
 */
export async function handlePluginCommands(plugins, command, args, context) {
  for (const plugin of plugins) {
    for (const handler of plugin.commandHandlers || []) {
      if (handler.command === command) {
        try {
          console.log(`🧩 插件命令: ${plugin.name}/${command}`)
          return await handler.handler(args, { ...context, ...plugin._context })
        } catch (e) {
          return `插件命令执行错误: ${e.message}`
        }
      }
    }
  }
  return null
}

/**
 * 处理消息事件（转发给所有插件监听器）
 * @returns {Promise<string|null>} 插件返回的回复文本（如果有）
 */
export async function dispatchMessage(plugins, message, context) {
  for (const plugin of plugins) {
    for (const listener of plugin.messageListeners || []) {
      try {
        const result = await listener(message, { ...context, ...plugin._context })
        if (result) return result
      } catch (e) {
        console.error(`❌ 插件 ${plugin.name} 消息监听失败:`, e.message)
      }
    }
  }
  return null
}

/**
 * 启动所有插件的定时任务
 * cronTasks: [{ schedule: '0 8 * * *', task: async (ctx) => {} }]
 * schedule 格式: 分 时 日 月 周 (cron 5段)
 */
export function startCronTasks(plugins) {
  const timers = []
  for (const plugin of plugins) {
    for (const task of plugin.cronTasks || []) {
      if (!task.schedule || typeof task.task !== 'function') continue
      const timer = scheduleCron(task.schedule, () => {
        console.log(`⏰ 插件定时任务触发: ${plugin.name} [${task.schedule}]`)
        try {
          task.task(plugin._context).catch((e) => console.error(`❌ 定时任务失败 ${plugin.name}:`, e.message))
        } catch (e) {
          console.error(`❌ 定时任务失败 ${plugin.name}:`, e.message)
        }
      })
      timers.push({ plugin: plugin.name, schedule: task.schedule, timer })
      console.log(`⏰ 定时任务已注册: ${plugin.name} [${task.schedule}]`)
    }
  }
  return timers
}

/**
 * 简易 cron 调度器（5段: 分 时 日 月 周）
 */
function scheduleCron(cronExpr, callback) {
  const parts = cronExpr.trim().split(/\s+/)
  if (parts.length !== 5) {
    console.error(`❌ cron 表达式格式错误: ${cronExpr}（需要 5 段: 分 时 日 月 周）`)
    return null
  }
  const [minPart, hourPart, dayPart, monthPart, weekPart] = parts

  function matches(value, part) {
    if (part === '*') return true
    // 支持 "*/15" 和 "1,2,3" 和 "5"
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10)
      return step > 0 && value % step === 0
    }
    if (part.includes(',')) {
      return part.split(',').map(Number).includes(value)
    }
    return parseInt(part, 10) === value
  }

  const timer = setInterval(() => {
    const now = new Date()
    const min = now.getMinutes()
    const hour = now.getHours()
    const day = now.getDate()
    const month = now.getMonth() + 1
    const week = now.getDay() // 0=周日
    if (matches(min, minPart) && matches(hour, hourPart) && matches(day, dayPart) && matches(month, monthPart) && matches(week, weekPart)) {
      callback()
    }
  }, 60000) // 每分钟检查一次
  return timer
}

/**
 * 获取插件列表信息（管理命令用）
 */
export function getPluginsInfo(plugins) {
  return plugins.map((p) => ({
    name: p.name,
    description: p.description,
    file: p.file,
    tools: (p.tools || []).map((t) => t.definition.function.name),
    commands: (p.commandHandlers || []).map((h) => `/${h.command}`),
    cron: (p.cronTasks || []).map((t) => t.schedule),
  }))
}
