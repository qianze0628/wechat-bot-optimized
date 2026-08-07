import fs from 'fs'
import path from 'path'

export async function captureTelegramUpdate(update, options = {}) {
  if (!options.storeMessages) return

  await fs.promises.mkdir(options.dataDir, { recursive: true })
  const message = update.message || {}
  const record = {
    capturedAt: new Date().toISOString(),
    updateId: update.update_id,
    messageId: message.message_id,
    chatId: message.chat?.id,
    chatType: message.chat?.type,
    userId: message.from?.id,
    username: message.from?.username,
    text: message.text || message.caption || '',
    date: message.date,
    raw: update,
  }

  await fs.promises.appendFile(path.join(options.dataDir, 'messages.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}

export async function readTelegramOffset(dataDir) {
  try {
    const content = await fs.promises.readFile(path.join(dataDir, 'offset.txt'), 'utf8')
    const offset = Number(content.trim())
    return Number.isFinite(offset) ? offset : undefined
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeTelegramOffset(dataDir, offset) {
  await fs.promises.mkdir(dataDir, { recursive: true })
  await fs.promises.writeFile(path.join(dataDir, 'offset.txt'), `${offset}\n`, 'utf8')
}
