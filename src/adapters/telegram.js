import axios from 'axios'
import { getTelegramRuntimeConfig } from '../config/env.js'

function getTelegramUrl(method, config = getTelegramRuntimeConfig()) {
  if (!config.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required')
  }

  return `${config.apiBaseUrl}/bot${config.botToken}/${method}`
}

export async function telegramGetUpdates(options = {}) {
  const config = getTelegramRuntimeConfig()
  const timeout = options.timeout ?? config.pollTimeout
  const response = await axios.post(
    getTelegramUrl('getUpdates', config),
    {
      offset: options.offset,
      timeout,
      allowed_updates: options.allowedUpdates || ['message'],
    },
    {
      timeout: (timeout + 10) * 1000,
    },
  )

  return response.data
}

export async function telegramSendText(options = {}) {
  const config = getTelegramRuntimeConfig()
  if (!options.chatId) {
    throw new Error('telegramSendText requires chatId')
  }

  const response = await axios.post(getTelegramUrl('sendMessage', config), {
    chat_id: options.chatId,
    text: options.text || '',
    message_thread_id: options.messageThreadId,
    reply_to_message_id: options.replyToMessageId,
    disable_web_page_preview: options.disableWebPagePreview ?? true,
  })

  return response.data
}
