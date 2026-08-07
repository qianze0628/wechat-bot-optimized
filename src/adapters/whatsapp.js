import axios from 'axios'
import { getWhatsAppRuntimeConfig } from '../config/env.js'

function getWhatsAppMessagesUrl(config = getWhatsAppRuntimeConfig()) {
  if (!config.accessToken) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is required')
  }
  if (!config.phoneNumberId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is required')
  }

  return `${config.apiBaseUrl}/${config.graphApiVersion}/${config.phoneNumberId}/messages`
}

export async function whatsAppSendText(options = {}) {
  const config = getWhatsAppRuntimeConfig()
  if (!options.to) {
    throw new Error('whatsAppSendText requires to')
  }

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: options.to,
    type: 'text',
    text: {
      preview_url: options.previewUrl === true,
      body: options.text || '',
    },
  }

  if (options.contextMessageId) {
    body.context = { message_id: options.contextMessageId }
  }

  const response = await axios.post(getWhatsAppMessagesUrl(config), body, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  return response.data
}
