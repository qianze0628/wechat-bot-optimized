#!/usr/bin/env node
// 实时二维码服务 - 从 wechat-bot 日志提取最新二维码并代理给浏览器
// 用法: node qr-server.js [端口]
// 环境变量: WECHAT_LOG_FILE 指定 wechat-bot 日志文件 (默认 ./logs/bot.log)
//           QR_PORT 指定端口 (默认 8090)
const http = require('http')
const fs = require('fs')
const path = require('path')

const LOG_FILE = process.env.WECHAT_LOG_FILE || path.join(__dirname, 'logs', 'bot.log')
const PORT = parseInt(process.env.QR_PORT || '8090', 10)

function getLatestQrUrl() {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8')
    // 用 indexOf 找最后一个 onScan (最可靠)
    const marker = 'onScan: '
    let lastIdx = -1
    let pos = content.indexOf(marker)
    while (pos !== -1) {
      lastIdx = pos
      pos = content.indexOf(marker, pos + marker.length)
    }
    if (lastIdx === -1) return null
    // 提取 URL (从 marker 后到空白/换行)
    const urlStart = lastIdx + marker.length
    let urlEnd = urlStart
    while (urlEnd < content.length && !/[\s\r\n]/.test(content[urlEnd])) urlEnd++
    const url = content.slice(urlStart, urlEnd)
    return url.startsWith('https://') ? url : null
  } catch (e) { return null }
}

// 登录状态: 以日志中"最后一次"状态事件为准
// (has logged in 在前 + 之后无 logout/onScan → 已登录; 有 logout/onScan → 未登录)
function loggedIn() {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8')
    const lastLogin = content.lastIndexOf('has logged in')
    const lastLogout = content.lastIndexOf('has logged out')
    const lastScan = content.lastIndexOf('onScan: ')
    // 如果最近的事件是 onScan 或 logout → 未登录; 否则若有 login → 已登录
    const lastEvent = Math.max(lastLogin, lastLogout, lastScan)
    if (lastEvent === -1) return false
    return lastEvent === lastLogin
  } catch (e) { return false }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>微信扫码登录</title>
<style>body{font-family:sans-serif;background:#f5f5f5;display:flex;flex-direction:column;align-items:center;padding:40px}
img{width:320px;height:320px;border:2px solid #ddd;border-radius:12px;background:#fff}
h2{color:#333}.tip{color:#888;margin-top:12px;font-size:14px}.ok{color:#188038;font-weight:bold;font-size:16px}</style></head>
<body><h2>📱 微信扫码登录</h2>
<img id="qr" src="/qr.png" alt="加载中...">
<div id="status" class="tip">等待扫码...</div>
<script>
setInterval(async () => {
  try {
    const st = await fetch('/status').then(r=>r.json());
    if (st.logged) { document.getElementById('status').className='tip ok'; document.getElementById('status').textContent='✅ 已登录!'; }
    else { document.getElementById('qr').src='/qr.png?t='+Date.now(); }
  } catch(e){}
}, 3000);
</script></body></html>`)
  } else if (url.pathname === '/qr.png') {
    const qrUrl = getLatestQrUrl()
    if (qrUrl) {
      const httpMod = qrUrl.startsWith('https') ? require('https') : require('http')
      httpMod.get(qrUrl, (r) => {
        if (r.statusCode === 200) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' })
          r.pipe(res)
        } else {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#eee"/><text x="160" y="160" text-anchor="middle" fill="#888">二维码获取失败</text></svg>')
        }
      }).on('error', () => {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#eee"/><text x="160" y="160" text-anchor="middle" fill="#888">等待二维码...</text></svg>')
      })
    } else {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#eee"/><text x="160" y="160" text-anchor="middle" fill="#888">等待二维码...</text></svg>')
    }
  } else if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ logged: loggedIn(), hasQr: !!getLatestQrUrl() }))
  } else {
    res.writeHead(404)
    res.end()
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[qr-server] http://localhost:${PORT}/qr.png  (读日志: ${LOG_FILE})`)
})
