import http from 'http'
import { getWhatsAppRuntimeConfig } from '../../config/env.js'
import { whatsAppSendText } from '../../adapters/whatsapp.js'
import { getServe } from '../../wechaty/serve.js'
import { captureWhatsAppMessage } from './messageStore.js'

function rememberSeen(seen, id, maxSize) {
  if (!id) return false
  if (seen.has(id)) return true

  seen.add(id)
  if (seen.size > maxSize) {
    const oldest = seen.values().next().value
    seen.delete(oldest)
  }

  return false
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString()
      if (body.length > 2 * 1024 * 1024) {
        req.destroy(new Error('request body too large'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function removePrefix(text, prefix) {
  if (!prefix) return text
  return text.trimStart().startsWith(prefix) ? text.trimStart().slice(prefix.length).trimStart() : text
}

export function extractWhatsAppMessages(payload) {
  const messages = []
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const message of change.value?.messages || []) {
        messages.push(message)
      }
    }
  }

  return messages
}

function getWhatsAppText(message) {
  return String(message?.text?.body || '').trim()
}

export function shouldReplyToWhatsAppMessage(message, config) {
  if (!message || !message.from) return false
  if (!config.agentMessageTypes.includes(message.type)) return false
  if (config.agentIgnoreUserIds.includes(message.from)) return false

  const content = getWhatsAppText(message)
  if (!content) return false

  if (config.agentUserWhiteList.length && !config.agentUserWhiteList.includes(message.from)) {
    return false
  }

  return !config.agentReplyPrefix || content.startsWith(config.agentReplyPrefix)
}

export function buildWhatsAppQuestion(message, config) {
  return removePrefix(getWhatsAppText(message), config.agentReplyPrefix).trim()
}

async function handleWhatsAppMessage(message, context) {
  const { config, getReply, seen, serviceType } = context
  if (rememberSeen(seen, message.id, config.dedupSize)) return

  await captureWhatsAppMessage(message, {
    dataDir: config.dataDir,
    storeMessages: config.storeMessages,
  })

  if (!shouldReplyToWhatsAppMessage(message, config)) return

  const question = buildWhatsAppQuestion(message, config)
  if (!question) return

  console.log(`WhatsApp message ${message.id} from ${message.from} -> ${serviceType}`)
  const response = await getReply(question)
  await whatsAppSendText({
    to: message.from,
    text: response,
    contextMessageId: message.id,
  })
}

function handleWebhookVerify(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token === config.verifyToken) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(challenge || '')
    return
  }

  res.writeHead(403, { 'Content-Type': 'text/plain' })
  res.end('Forbidden')
}

export function startWhatsAppAgent(options = {}) {
  const config = getWhatsAppRuntimeConfig()
  const serviceType = options.serviceType || options.agent || 'pi'
  const getReply = getServe(serviceType)
  const seen = new Set()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname !== config.webhookPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
      return
    }

    if (req.method === 'GET') {
      handleWebhookVerify(req, res, config)
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('Method Not Allowed')
      return
    }

    try {
      const rawBody = await readRequestBody(req)
      const payload = rawBody ? JSON.parse(rawBody) : {}
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('EVENT_RECEIVED')

      for (const message of extractWhatsAppMessages(payload)) {
        handleWhatsAppMessage(message, { config, getReply, seen, serviceType }).catch((error) => {
          console.error('WhatsApp message handling failed:', error.response?.data?.error?.message || error.message)
        })
      }
    } catch (error) {
      console.error('WhatsApp webhook failed:', error.message)
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Bad Request')
      }
    }
  })

  server.listen(config.webhookPort, config.webhookHost, () => {
    console.log(`WhatsApp webhook listening on http://${config.webhookHost}:${config.webhookPort}${config.webhookPath}`)
    console.log(`WhatsApp agent service type: ${serviceType}`)
  })

  const stop = () => {
    server.close(() => {
      console.log('WhatsApp agent stopped')
    })
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  return server
}
