import { remark } from 'remark'
import stripMarkdown from 'strip-markdown'
import OpenAIApi from 'openai'
import dotenv from 'dotenv'
const env = dotenv.config().parsed // 环境参数
import fs from 'fs'
import path from 'path'

const __dirname = path.resolve()
// 判断是否有 .env 文件, 没有则报错
const envPath = path.join(__dirname, '.env')
if (!fs.existsSync(envPath)) {
  console.log('❌ 请先根据文档，创建并配置.env文件！')
  process.exit(1)
}

let config = {
  apiKey: env.OPENAI_API_KEY,
  organization: '',
}
if (env.OPENAI_PROXY_URL) {
  config.baseURL = env.OPENAI_PROXY_URL
}
const openai = new OpenAIApi(config)
const chosen_model = env.OPENAI_MODEL || 'gpt-4o'

/**
 * 增强版回复：支持多轮上下文 + 工具调用
 * @param {string} prompt 用户问题
 * @param {object} options { system, history(数组), tools(数组), toolExecutor(函数) }
 */
export async function getGptReply(prompt, options = {}) {
  console.log('🚀🚀🚀 / prompt', prompt)

  const messages = []
  // 系统提示
  const systemContent = options.system || env.OPENAI_SYSTEM_MESSAGE
  if (systemContent) messages.push({ role: 'system', content: systemContent })
  // 历史对话（多轮记忆）
  if (options.history && options.history.length) {
    // history 是 [{role, content}] 数组
    messages.push(...options.history.slice(-20))
  }
  // 当前问题
  messages.push({ role: 'user', content: prompt })

  // 工具调用循环（最多3轮）
  const tools = options.tools || undefined
  const toolExecutor = options.toolExecutor || null
  let currentMessages = messages

  for (let round = 0; round < 3; round++) {
    const requestBody = {
      messages: currentMessages,
      model: chosen_model,
    }
    if (tools && tools.length) requestBody.tools = tools

    const response = await openai.chat.completions.create(requestBody)
    const choice = response.choices[0]
    const message = choice.message

    // 检查是否有工具调用
    if (message.tool_calls && message.tool_calls.length && toolExecutor) {
      console.log('🔧 AI 请求工具调用:', JSON.stringify(message.tool_calls.map(tc => tc.function.name)))
      // 把 assistant 的工具调用消息加入上下文
      currentMessages.push(message)
      // 执行每个工具并返回结果
      for (const toolCall of message.tool_calls) {
        let result
        try {
          const args = JSON.parse(toolCall.function.arguments || '{}')
          result = await toolExecutor(toolCall.function.name, args)
        } catch (e) {
          result = `工具执行错误: ${e.message}`
        }
        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: String(result),
        })
      }
      continue // 继续下一轮，让 AI 基于工具结果回复
    }

    // 无工具调用，正常回复
    console.log('🚀🚀🚀 / reply', message.content)
    return `${message.content}`
  }

  // 工具循环结束后兜底
  const lastReply = currentMessages[currentMessages.length - 1]
  return lastReply?.content || '抱歉，处理超时了'
}
