import fs from 'fs'
import path from 'path'

export async function captureLarkMessage(event, options = {}) {
  if (!options.storeMessages) return

  await fs.promises.mkdir(options.dataDir, { recursive: true })
  const record = {
    capturedAt: new Date().toISOString(),
    eventId: event.event_id || '',
    messageId: event.message_id || event.id || '',
    chatId: event.chat_id || '',
    chatType: event.chat_type || '',
    senderId: event.sender_id || '',
    messageType: event.message_type || '',
    content: event.content || '',
    createTime: event.create_time || '',
    timestamp: event.timestamp || '',
    raw: event,
  }

  await fs.promises.appendFile(path.join(options.dataDir, 'messages.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}
