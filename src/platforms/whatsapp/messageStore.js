import fs from 'fs'
import path from 'path'

export async function captureWhatsAppMessage(message, options = {}) {
  if (!options.storeMessages) return

  await fs.promises.mkdir(options.dataDir, { recursive: true })
  const record = {
    capturedAt: new Date().toISOString(),
    messageId: message.id || '',
    from: message.from || '',
    type: message.type || '',
    text: message.text?.body || '',
    timestamp: message.timestamp || '',
    raw: message,
  }

  await fs.promises.appendFile(path.join(options.dataDir, 'messages.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}
