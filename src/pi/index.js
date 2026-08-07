import { askPi } from '../adapters/pi.js'

export async function getPiReply(prompt) {
  const agentPrompt = [
    '你是当前 wechat-bot 项目的 Pi agent，通过 IM 渠道和外部用户沟通。',
    '请直接回答用户问题；如果需要访问本地微信聊天、朋友圈、群成员或统计数据，优先建议或使用项目中的 wb wx / wb analyze 能力。',
    '不要编造本地数据；没有读取到数据时要明确说明。',
    '',
    `用户消息：${prompt}`,
  ].join('\n')

  return askPi(agentPrompt)
}
