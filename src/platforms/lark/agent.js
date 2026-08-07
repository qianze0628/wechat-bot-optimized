import { spawn } from 'child_process'
import { getLarkRuntimeConfig } from '../../config/env.js'
import { larkSendTextRaw } from '../../adapters/lark.js'
import { getServe } from '../../wechaty/serve.js'
import { captureLarkMessage } from './messageStore.js'

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

function removePrefix(text, prefix) {
  if (!prefix) return text
  return text.trimStart().startsWith(prefix) ? text.trimStart().slice(prefix.length).trimStart() : text
}

function removeMentionName(text, mentionName) {
  if (!mentionName) return text
  return text.replace(mentionName, '').trim()
}

export function shouldReplyToLarkEvent(event, config) {
  if (!event || event.type !== 'im.message.receive_v1') return false
  if (!event.chat_id || !event.sender_id) return false
  if (!config.agentChatTypes.includes(event.chat_type)) return false
  if (!config.agentMessageTypes.includes(event.message_type)) return false
  if (config.agentIgnoreSenderIds.includes(event.sender_id)) return false

  const content = String(event.content || '').trim()
  if (!content) return false

  if (config.agentUserWhiteList.length && !config.agentUserWhiteList.includes(event.sender_id)) {
    return false
  }

  if (event.chat_type === 'p2p') {
    if (config.agentChatWhiteList.length && !config.agentChatWhiteList.includes(event.chat_id)) {
      return false
    }

    return !config.agentReplyPrefix || content.startsWith(config.agentReplyPrefix)
  }

  if (event.chat_type === 'group') {
    if (!config.agentChatWhiteList.includes(event.chat_id)) return false

    const matchedPrefix = config.agentReplyPrefix && content.startsWith(config.agentReplyPrefix)
    const matchedMention = config.agentGroupMentionName && content.includes(config.agentGroupMentionName)
    return Boolean(config.agentGroupAutoReply || matchedPrefix || matchedMention)
  }

  return false
}

export function buildLarkQuestion(event, config) {
  const withoutMention = removeMentionName(String(event.content || ''), config.agentGroupMentionName)
  return removePrefix(withoutMention, config.agentReplyPrefix).trim()
}

async function handleLarkEvent(event, context) {
  const { config, getReply, seen, serviceType } = context
  const eventId = event.event_id || event.message_id || event.id
  if (rememberSeen(seen, eventId, config.dedupSize)) return

  await captureLarkMessage(event, {
    dataDir: config.dataDir,
    storeMessages: config.storeMessages,
  })

  if (!shouldReplyToLarkEvent(event, config)) return

  const question = buildLarkQuestion(event, config)
  if (!question) return

  console.log(`Lark ${event.chat_type} message ${event.message_id || event.id || event.event_id} -> ${serviceType}`)
  const response = await getReply(question)
  await larkSendTextRaw({
    as: config.agentIdentity,
    chatId: event.chat_id,
    text: response,
    idempotencyKey: `wechat-bot-${event.message_id || event.event_id || Date.now()}`,
  })
}

function handleNdjsonChunk(chunk, state, onEvent) {
  state.buffer += chunk.toString()
  const lines = state.buffer.split(/\r?\n/)
  state.buffer = lines.pop() || ''

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      onEvent(JSON.parse(line))
    } catch (error) {
      console.error('Failed to parse Lark event:', error.message)
      console.error(line)
    }
  }
}

export function startLarkAgent(options = {}) {
  const config = getLarkRuntimeConfig()
  const serviceType = options.serviceType || options.agent || 'pi'
  const getReply = getServe(serviceType)
  const args = ['event', 'consume', config.agentEventKey, '--as', config.agentIdentity]
  const child = spawn(config.bin, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const seen = new Set()
  const state = { buffer: '' }
  let chain = Promise.resolve()

  console.log(`Starting Lark agent: ${config.bin} ${args.join(' ')}`)
  console.log(`Lark agent service type: ${serviceType}`)

  child.stdout.on('data', (chunk) => {
    handleNdjsonChunk(chunk, state, (event) => {
      chain = chain
        .then(() => handleLarkEvent(event, { config, getReply, seen, serviceType }))
        .catch((error) => {
          console.error('Lark event handling failed:', error.message)
          if (error.result?.stderr) console.error(error.result.stderr)
        })
    })
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
  })

  child.on('error', (error) => {
    console.error('Lark event consumer failed to start:', error.message)
  })

  child.on('close', (code, signal) => {
    console.log(`Lark event consumer exited with code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}`)
  })

  const stop = () => {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  return child
}
