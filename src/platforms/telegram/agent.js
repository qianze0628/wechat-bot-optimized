import { getTelegramRuntimeConfig } from '../../config/env.js'
import { telegramGetUpdates, telegramSendText } from '../../adapters/telegram.js'
import { getServe } from '../../wechaty/serve.js'
import { captureTelegramUpdate, readTelegramOffset, writeTelegramOffset } from './messageStore.js'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toId(value) {
  return value === undefined || value === null ? '' : String(value)
}

function removePrefix(text, prefix) {
  if (!prefix) return text
  return text.trimStart().startsWith(prefix) ? text.trimStart().slice(prefix.length).trimStart() : text
}

function removeMentionName(text, mentionName) {
  if (!mentionName) return text
  return text.replace(mentionName, '').trim()
}

function getTelegramMessage(update) {
  return update?.message || null
}

function getTelegramText(message) {
  return String(message?.text || message?.caption || '').trim()
}

export function shouldReplyToTelegramUpdate(update, config) {
  const message = getTelegramMessage(update)
  if (!message || !message.chat || !message.from) return false
  if (!config.agentChatTypes.includes(message.chat.type)) return false
  if (config.agentIgnoreUserIds.includes(toId(message.from.id))) return false

  const content = getTelegramText(message)
  if (!content) return false

  if (config.agentUserWhiteList.length && !config.agentUserWhiteList.includes(toId(message.from.id))) {
    return false
  }

  if (message.chat.type === 'private') {
    if (config.agentChatWhiteList.length && !config.agentChatWhiteList.includes(toId(message.chat.id))) {
      return false
    }

    return !config.agentReplyPrefix || content.startsWith(config.agentReplyPrefix)
  }

  if (config.agentChatWhiteList.length && !config.agentChatWhiteList.includes(toId(message.chat.id))) {
    return false
  }

  const matchedPrefix = config.agentReplyPrefix && content.startsWith(config.agentReplyPrefix)
  const matchedMention = config.agentGroupMentionName && content.includes(config.agentGroupMentionName)
  return Boolean(config.agentGroupAutoReply || matchedPrefix || matchedMention)
}

export function buildTelegramQuestion(update, config) {
  const message = getTelegramMessage(update)
  const withoutMention = removeMentionName(getTelegramText(message), config.agentGroupMentionName)
  return removePrefix(withoutMention, config.agentReplyPrefix).trim()
}

async function handleTelegramUpdate(update, context) {
  const { config, getReply, serviceType } = context
  await captureTelegramUpdate(update, {
    dataDir: config.dataDir,
    storeMessages: config.storeMessages,
  })

  if (!shouldReplyToTelegramUpdate(update, config)) return

  const message = getTelegramMessage(update)
  const question = buildTelegramQuestion(update, config)
  if (!question) return

  console.log(`Telegram ${message.chat.type} message ${message.message_id} -> ${serviceType}`)
  const response = await getReply(question)
  await telegramSendText({
    chatId: message.chat.id,
    messageThreadId: message.message_thread_id,
    replyToMessageId: message.message_id,
    text: response,
  })
}

export async function startTelegramAgent(options = {}) {
  const config = getTelegramRuntimeConfig()
  const serviceType = options.serviceType || options.agent || 'pi'
  const getReply = getServe(serviceType)
  let offset = await readTelegramOffset(config.dataDir)
  let running = true

  console.log('Starting Telegram agent with long polling')
  console.log(`Telegram agent service type: ${serviceType}`)

  const stop = () => {
    running = false
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  while (running) {
    try {
      const result = await telegramGetUpdates({ offset, timeout: config.pollTimeout })
      if (!result.ok) {
        throw new Error(result.description || 'Telegram getUpdates failed')
      }

      for (const update of result.result || []) {
        await handleTelegramUpdate(update, { config, getReply, serviceType })
        offset = update.update_id + 1
        await writeTelegramOffset(config.dataDir, offset)
      }
    } catch (error) {
      console.error('Telegram polling failed:', error.response?.data?.description || error.message)
      await sleep(config.pollIntervalMs)
    }
  }

  console.log('Telegram agent stopped')
}
