// Stands in for an SMS service in the e2e suite: the plugin's HTTP provider posts each text
// message here, and it's written to a folder for the tests to read, as mail-file does email.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const PORT = Number(process.env.FAKE_SMS_PORT ?? 3496)
const TOKEN = process.env.OTP_SMS_TOKEN ?? ''
const DIR = process.env.FAKE_SMS_DIR ?? '.data/e2e-sms'

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
let received = 0

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200).end('ok')
    return
  }
  if (request.method !== 'POST' || request.url !== '/sms') {
    response.writeHead(404).end()
    return
  }
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ message: 'bad token' }))
    return
  }
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const name = `${String(++received).padStart(4, '0')}.json`
    writeFileSync(join(DIR, name), body)
    response.writeHead(202, { 'content-type': 'application/json' }).end('{"queued":true}')
  })
}).listen(PORT, '127.0.0.1')
