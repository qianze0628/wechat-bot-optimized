// 工具调用模块 - 扩充版工具集
import { execSync } from 'child_process'

// ===== 工具定义 =====
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前日期和时间（北京时间）',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc',
      description: '计算数学表达式，如 "1+2*3"、"(5+7)/2"',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: '数学表达式' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unit_convert',
      description: '单位换算：长度(m/km/cm)、重量(kg/g/t)、温度(C/F)、速度(kmh/mph)等',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: '数值' },
          from: { type: 'string', description: '原单位' },
          to: { type: 'string', description: '目标单位' },
        },
        required: ['value', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_dice',
      description: '掷骰子，生成 1 到指定面数之间的随机数（默认 6 面）',
      parameters: {
        type: 'object',
        properties: { sides: { type: 'number', description: '骰子面数，默认6' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: '搜索本地对话记忆（这个用户之前跟 AI 聊过的历史）',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '搜索关键词' } },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询城市实时天气（通过 wttr.in 公共接口，无需 key）',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名，如 北京' } },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '网页搜索（通过 Bing 搜索接口），返回搜索结果摘要',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '获取指定网页的内容摘要（前2000字符）',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整URL' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_price',
      description: '查询股票/指数价格（通过新浪财经接口，如 sh600519 贵州茅台、hk00700 腾讯）',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '股票代码，如 sh600519, sz000001, hk00700' } },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_exchange_rate',
      description: '查询货币汇率（通过公开接口）',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string', description: '源货币，如 USD' }, to: { type: 'string', description: '目标货币，如 CNY' } },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ip_info',
      description: '查询 IP 地址信息（归属地、运营商等）',
      parameters: {
        type: 'object',
        properties: { ip: { type: 'string', description: 'IP地址，留空查本机IP' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'random_number',
      description: '生成指定范围的随机数',
      parameters: {
        type: 'object',
        properties: { min: { type: 'number', description: '最小值，默认1' }, max: { type: 'number', description: '最大值，默认100' } },
      },
    },
  },
]

// ===== 工具执行器 =====
export async function executeTool(name, args, context = {}) {
  console.log('🔧 调用工具:', name, JSON.stringify(args))
  try {
    switch (name) {
      case 'get_current_time': {
        const now = new Date()
        const opts = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' }
        return `当前时间（北京时间）：${now.toLocaleString('zh-CN', opts)}`
      }
      case 'calc': {
        const expr = String(args.expression || '').replace(/[^0-9+\-*/().\s]/g, '')
        if (!expr) return '表达式为空'
        const result = Function(`"use strict"; return (${expr})`)()
        return `${args.expression} = ${result}`
      }
      case 'unit_convert': {
        const { value, from, to } = args
        // 简单换算表（米为基准）
        const length = { m: 1, km: 1000, cm: 0.01, mm: 0.001, mile: 1609.34, ft: 0.3048 }
        const weight = { kg: 1, g: 0.001, t: 1000, lb: 0.453592, oz: 0.0283495 }
        const f = from.toLowerCase(), t = to.toLowerCase()
        if (length[f] && length[t]) return `${value}${from} = ${(value * length[f] / length[t]).toFixed(4)}${to}`
        if (weight[f] && weight[t]) return `${value}${from} = ${(value * weight[f] / weight[t]).toFixed(4)}${to}`
        if (f === 'c' && t === 'f') return `${value}°C = ${(value * 9/5 + 32).toFixed(1)}°F`
        if (f === 'f' && t === 'c') return `${value}°F = ${((value - 32) * 5/9).toFixed(1)}°C`
        return `不支持的单位换算: ${from} → ${to}`
      }
      case 'roll_dice': {
        const sides = Math.max(1, Math.floor(args.sides || 6))
        const result = Math.floor(Math.random() * sides) + 1
        return `🎲 掷出了 ${result}（1-${sides}）`
      }
      case 'random_number': {
        const min = Math.floor(args.min || 1), max = Math.floor(args.max || 100)
        if (min >= max) return '最小值必须小于最大值'
        const result = Math.floor(Math.random() * (max - min + 1)) + min
        return `随机数：${result}（范围 ${min}-${max}）`
      }
      case 'search_memory': {
        if (context.searchMemory) return context.searchMemory(args.keyword || '')
        return '暂无相关记忆'
      }
      case 'get_weather': {
        const city = encodeURIComponent(args.city || '北京')
        const url = `https://wttr.in/${city}?format=3`
        const out = execSync(`curl -s --max-time 8 "${url}"`, { encoding: 'utf8' }).trim()
        return out || `无法获取 ${args.city} 天气`
      }
      case 'web_search': {
        const query = encodeURIComponent(args.query || '')
        const url = `https://www.bing.com/search?q=${query}`
        const html = execSync(`curl -s --max-time 8 -A "Mozilla/5.0" "${url}"`, { encoding: 'utf8', maxBuffer: 1024*1024*5 })
        // 提取搜索结果标题和摘要
        const results = []
        const re = /<li class="b_algo".*?<h2><a[^>]*>(.*?)<\/a><\/h2>.*?<p[^>]*>(.*?)<\/p>/gs
        let m
        let count = 0
        while ((m = re.exec(html)) && count < 5) {
          const title = m[1].replace(/<[^>]+>/g, '').trim()
          const snippet = m[2].replace(/<[^>]+>/g, '').trim()
          results.push(`${title}：${snippet}`)
          count++
        }
        return results.length ? results.join('\n') : '未找到搜索结果'
      }
      case 'fetch_url': {
        const url = args.url || ''
        if (!/^https?:\/\//.test(url)) return 'URL 必须以 http:// 或 https:// 开头'
        const html = execSync(`curl -sL --max-time 10 -A "Mozilla/5.0" "${url}"`, { encoding: 'utf8', maxBuffer: 1024*1024*5 })
        const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        return text.slice(0, 2000) || '网页内容为空或无法解析'
      }
      case 'get_stock_price': {
        const code = args.code || ''
        const url = `https://hq.sinajs.cn/list=${code}`
        const out = execSync(`curl -s --max-time 8 -H "Referer: https://finance.sina.com.cn" "${url}"`, { encoding: 'utf8', maxBuffer: 1024*1024*2 })
        const match = out.match(/="([^"]*)"/)
        if (!match) return `无法获取 ${code} 行情`
        const parts = match[1].split(',')
        if (parts.length < 4) return `无法解析 ${code} 行情`
        // A股格式：名称,今开,昨收,当前价,最高,最低...
        if (code.startsWith('sh') || code.startsWith('sz')) {
          return `${parts[0]}：当前价 ${parts[3]}，今开 ${parts[1]}，昨收 ${parts[2]}，最高 ${parts[4]}，最低 ${parts[5]}`
        }
        return `行情数据：${match[1].slice(0, 200)}`
      }
      case 'get_exchange_rate': {
        const from = (args.from || 'USD').toUpperCase()
        const to = (args.to || 'CNY').toUpperCase()
        const url = `https://open.er-api.com/v6/latest/${from}`
        const out = execSync(`curl -s --max-time 8 "${url}"`, { encoding: 'utf8' })
        const data = JSON.parse(out)
        if (data.result === 'success' && data.rates[to]) {
          return `1 ${from} = ${data.rates[to]} ${to}（更新于 ${data.time_last_update_utc}）`
        }
        return `无法获取 ${from}→${to} 汇率`
      }
      case 'ip_info': {
        const ip = args.ip || ''
        const url = ip ? `http://ip-api.com/json/${ip}?lang=zh-CN` : 'http://ip-api.com/json/?lang=zh-CN'
        const out = execSync(`curl -s --max-time 8 "${url}"`, { encoding: 'utf8' })
        const data = JSON.parse(out)
        if (data.status === 'success') {
          return `IP ${data.query}：${data.country} ${data.regionName} ${data.city}，运营商 ${data.isp}`
        }
        return 'IP 查询失败'
      }
      default:
        return `未知工具：${name}`
    }
  } catch (e) {
    return `工具执行错误：${e.message}`
  }
}
