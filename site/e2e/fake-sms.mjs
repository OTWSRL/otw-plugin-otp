// Stands in for an SMS service and for WhatsApp's Cloud API in the e2e suite: the plugin's HTTP
// provider posts each text message here, its WhatsApp provider each template message, and each
// is written to a folder for the tests to read, as mail-file does email.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const PORT = Number(process.env.FAKE_SMS_PORT ?? 3496)
const TOKEN = process.env.OTP_SMS_TOKEN ?? ''
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN ?? ''
/** `POST /{version}/{phone number id}/messages`, as the Graph API has it. */
const WHATSAPP = /^\/v\d+\.\d+\/(\d+)\/messages$/
const DIR = process.env.FAKE_SMS_DIR ?? '.data/e2e-sms'

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
let received = 0

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200).end('ok')
    return
  }
  const whatsApp = WHATSAPP.exec(request.url ?? '')
  if (request.method !== 'POST' || (request.url !== '/sms' && !whatsApp)) {
    response.writeHead(404).end()
    return
  }
  if (request.headers.authorization !== `Bearer ${whatsApp ? WHATSAPP_TOKEN : TOKEN}`) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'bad token', code: 190 } }))
    return
  }
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const name = `${String(++received).padStart(4, '0')}.json`
    if (whatsApp) {
      // Kept in the shape the tests read a text message in: where it went, and what it said.
      const sent = JSON.parse(body)
      const code = sent.template.components[0].parameters[0].text
      const text = `whatsapp ${sent.template.name} ${sent.template.language.code} ${code}`
      writeFileSync(
        join(DIR, name),
        JSON.stringify({ to: `+${sent.to}`, text, phoneId: whatsApp[1] }),
      )
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ messages: [{ id: `wamid.${received}` }] }))
      return
    }
    writeFileSync(join(DIR, name), body)
    response.writeHead(202, { 'content-type': 'application/json' }).end('{"queued":true}')
  })
}).listen(PORT, '127.0.0.1')
