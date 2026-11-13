import { describe, expect, it, vi } from 'vitest'
import {
  chooseProvider,
  emailChannel,
  maskAddress,
  messageText,
  normalizeAddress,
  smsChannel,
  type SmsProvider,
} from '../src/channels'
import {
  encoderFor,
  fill,
  headersProblem,
  httpProblem,
  httpProvider,
  isHttpUrl,
  twilioProvider,
} from '../src/sms'
import { bootOtp } from './fixtures'

/** A `fetch` that answers as told, and keeps what it was asked. */
function fakeFetch(status = 201, body: unknown = { sid: 'SM123' }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    // A 204 has no body at all.
    return new Response(status === 204 ? null : text, { status })
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

const MESSAGE = { to: '+393331234567', text: '123456 is your Shop code.' }

describe('Twilio', () => {
  const account = { accountSid: 'AC123', authToken: 'token', from: '+14155552671' }

  it('posts the message to the account’s Messages, signed in with its SID and token', async () => {
    const { fetcher, calls } = fakeFetch()
    const twilio = twilioProvider(() => account, fetcher)
    expect(twilio.ready()).toBe(true)
    await twilio.send(MESSAGE)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from('AC123:token').toString('base64')}`)
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(calls[0]!.init.body as URLSearchParams)).toEqual({
      To: '+393331234567',
      Body: '123456 is your Shop code.',
      From: '+14155552671',
    })
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends through a Messaging Service when the sender is one', async () => {
    const { fetcher, calls } = fakeFetch()
    await twilioProvider(() => ({ ...account, from: 'MG999' }), fetcher).send(MESSAGE)
    const body = Object.fromEntries(calls[0]!.init.body as URLSearchParams)
    expect(body).toMatchObject({ MessagingServiceSid: 'MG999' })
    expect(body).not.toHaveProperty('From')
  })

  it('signs in with an API key instead of the token, when it has one', async () => {
    const { fetcher, calls } = fakeFetch()
    const twilio = twilioProvider(
      () => ({ accountSid: 'AC123', apiKey: 'SK456', apiSecret: 'secret', from: '+14155552671' }),
      fetcher,
    )
    expect(twilio.ready()).toBe(true)
    await twilio.send(MESSAGE)
    expect(calls[0]!.url).toContain('/Accounts/AC123/')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('SK456:secret').toString('base64')}`,
    )
  })

  it('isn’t ready until its SID, a token and a sender are all set', async () => {
    for (const missing of ['accountSid', 'authToken', 'from'] as const) {
      const twilio = twilioProvider(() => ({ ...account, [missing]: undefined }))
      expect(twilio.ready()).toBe(false)
      await expect(twilio.send(MESSAGE)).rejects.toThrow('not all set')
    }
    // Half an API key is no key: the token is used.
    expect(twilioProvider(() => ({ ...account, apiKey: 'SK456' })).ready()).toBe(true)
  })

  it('reports why Twilio refused, for the log', async () => {
    const refused = fakeFetch(400, { code: 21211, message: "The 'To' number is not valid." })
    await expect(twilioProvider(() => account, refused.fetcher).send(MESSAGE)).rejects.toThrow(
      "Twilio answered 400: The 'To' number is not valid. (21211)",
    )
    const down = fakeFetch(503, 'upstream unavailable')
    await expect(twilioProvider(() => account, down.fetcher).send(MESSAGE)).rejects.toThrow(
      'Twilio answered 503: upstream unavailable',
    )
  })

  it('can be pointed at another address, for tests', async () => {
    const { fetcher, calls } = fakeFetch()
    await twilioProvider(() => ({ ...account, api: 'http://127.0.0.1:3496/' }), fetcher).send(
      MESSAGE,
    )
    expect(calls[0]!.url).toBe('http://127.0.0.1:3496/2010-04-01/Accounts/AC123/Messages.json')
  })
})

describe('an HTTP request', () => {
  const URL = 'https://sms.example.com/send'

  it('by default posts the number and the text as JSON, with the token when there is one', async () => {
    const { fetcher, calls } = fakeFetch(200, 'ok')
    const http = httpProvider(() => ({ url: URL, token: 'abc' }), fetcher)
    expect(http.ready()).toBe(true)
    await http.send(MESSAGE)
    expect(calls[0]!.url).toBe(URL)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toEqual({
      authorization: 'Bearer abc',
      'content-type': 'application/json',
    })
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(MESSAGE)

    const bare = fakeFetch(204, '')
    await httpProvider(() => ({ url: URL }), bare.fetcher).send(MESSAGE)
    expect(bare.calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' })
    // Authorization set to none sends no token, even when one is in the environment.
    const none = fakeFetch()
    await httpProvider(() => ({ url: URL, auth: 'none', token: 'abc' }), none.fetcher).send(MESSAGE)
    expect(none.calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('sends custom headers, reading the ones marked env: from the environment', async () => {
    const { fetcher, calls } = fakeFetch()
    const http = httpProvider(
      () => ({
        url: URL,
        auth: 'headers',
        // Not sent: the headers are what signs this request in.
        token: 'abc',
        headers: [
          { name: 'X-Api-Key', value: 'env:SMS_API_KEY' },
          { name: 'X-Sender', value: 'My Site' },
        ],
        env: { SMS_API_KEY: 'from-the-environment' },
      }),
      fetcher,
    )
    expect(http.ready()).toBe(true)
    await http.send(MESSAGE)
    expect(calls[0]!.init.headers).toEqual({
      'X-Api-Key': 'from-the-environment',
      'X-Sender': 'My Site',
      'content-type': 'application/json',
    })
  })

  it('isn’t ready while an env: header’s variable is missing, and names the variable, not a value', async () => {
    const http = httpProvider(() => ({
      url: URL,
      auth: 'headers',
      headers: [{ name: 'X-Api-Key', value: 'env:SMS_API_KEY' }],
      env: {},
    }))
    expect(http.ready()).toBe(false)
    await expect(http.send(MESSAGE)).rejects.toThrow(
      'The header X-Api-Key reads SMS_API_KEY, which isn’t set',
    )
    expect(httpProblem({ url: URL, auth: 'headers', headers: [], env: {} })).toBeNull()
  })

  it('refuses headers that aren’t headers, or that would change where the request goes', () => {
    const problem = (name: string, value = 'x') => headersProblem([{ name, value }])
    expect(problem('X-Api-Key')).toBeNull()
    expect(problem('Authorization', 'Basic abc=')).toBeNull()
    expect(problem('X Api Key')).toBe('"X Api Key" isn’t a header name')
    expect(problem('X-Key:')).toBe('"X-Key:" isn’t a header name')
    expect(problem('Host')).toBe('Host is set by the request itself')
    expect(problem('content-length')).toBe('content-length is set by the request itself')
    // A line break in a value would start a header of the attacker's own.
    expect(problem('X-Key', 'abc\r\nX-Injected: 1')).toBe('The value of X-Key must be one line')
    expect(problem('X-Key', 'env:not a name')).toContain('after "env:" comes')
    expect(problem('X-Key', 'env:lower_case')).toContain('after "env:" comes')
  })

  it('sends a form, when the service takes one', async () => {
    const { fetcher, calls } = fakeFetch()
    await httpProvider(() => ({ url: URL, body: 'form' }), fetcher).send(MESSAGE)
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(calls[0]!.init.body).toBe('to=%2B393331234567&text=123456+is+your+Shop+code.')
  })

  it('sends a template of your own, with the number and the message escaped for its type', async () => {
    const text = 'Say "hi" & <go>\nnow'
    const send = async (template: string, contentType?: string) => {
      const { fetcher, calls } = fakeFetch()
      await httpProvider(
        () => ({ url: URL, body: 'template', template, contentType }),
        fetcher,
      ).send({ to: '+393331234567', text })
      return calls[0]!.init
    }
    const json = await send('{ "recipients": ["{{to}}"], "message": { "body": "{{ text }}" } }')
    expect((json.headers as Record<string, string>)['content-type']).toBe('application/json')
    // Still JSON, whatever the message holds.
    expect(JSON.parse(json.body as string)).toEqual({
      recipients: ['+393331234567'],
      message: { body: text },
    })

    const form = await send('To={{to}}&Body={{text}}', 'application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(form.body as string))).toEqual({
      To: '+393331234567',
      Body: text,
    })

    const xml = await send('<sms to="{{to}}">{{text}}</sms>', 'text/xml; charset=utf-8')
    expect(xml.body).toBe('<sms to="+393331234567">Say &quot;hi&quot; &amp; &lt;go&gt;\nnow</sms>')
    expect((xml.headers as Record<string, string>)['content-type']).toBe('text/xml; charset=utf-8')
  })

  it('sends a GET with the number and the message in the address, and no body', async () => {
    const { fetcher, calls } = fakeFetch()
    await httpProvider(
      () => ({
        url: 'https://sms.example.com/send?to={{to}}&msg={{text}}&from=Shop',
        method: 'GET',
        body: 'template',
      }),
      fetcher,
    ).send({ to: '+393331234567', text: 'a & b' })
    expect(calls[0]!.url).toBe(
      'https://sms.example.com/send?to=%2B393331234567&msg=a%20%26%20b&from=Shop',
    )
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.body).toBeUndefined()
    expect(calls[0]!.init.headers).toEqual({})
  })

  it('lets a custom Content-Type header have the last word', async () => {
    const { fetcher, calls } = fakeFetch()
    await httpProvider(
      () => ({
        url: URL,
        auth: 'headers',
        headers: [{ name: 'Content-Type', value: 'application/vnd.sms+json' }],
      }),
      fetcher,
    ).send(MESSAGE)
    expect(calls[0]!.init.headers).toEqual({ 'Content-Type': 'application/vnd.sms+json' })
  })

  it('needs an http or https address, and a template when one is chosen', async () => {
    expect(isHttpUrl(URL)).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:3496/sms')).toBe(true)
    for (const bad of ['', 'sms.example.com', 'ftp://example.com', 'javascript:alert(1)']) {
      expect(isHttpUrl(bad)).toBe(false)
      const http = httpProvider(() => ({ url: bad }))
      expect(http.ready()).toBe(false)
      await expect(http.send(MESSAGE)).rejects.toThrow('The request’s URL is not set')
    }
    expect(httpProblem({ url: URL, body: 'template', template: '  ' })).toBe(
      'The request’s body template is empty',
    )
  })

  it('reports an answer that isn’t a 2xx', async () => {
    const { fetcher } = fakeFetch(401, { message: 'bad token' })
    await expect(httpProvider(() => ({ url: URL }), fetcher).send(MESSAGE)).rejects.toThrow(
      'The SMS endpoint answered 401: bad token',
    )
  })

  it('escapes by content type, and leaves other text as it is', () => {
    expect(encoderFor('application/json')('a"b\\c')).toBe('a\\"b\\\\c')
    expect(encoderFor('application/x-www-form-urlencoded')('a b&c')).toBe('a%20b%26c')
    expect(encoderFor('text/plain')('a<b')).toBe('a<b')
    expect(
      fill('{{to}} {{ text }} {{other}}', { to: '1', text: '2' }, (value) => `[${value}]`),
    ).toBe('[1] [2] {{other}}')
  })
})

describe('choosing a provider', () => {
  const provider = (id: string, ready: boolean): SmsProvider => ({
    id,
    label: id,
    ready: () => ready,
    send: async () => {},
  })
  const builtIn = ['twilio', 'http']

  it('uses the one Settings names, or none while that one isn’t ready', () => {
    const all = [provider('twilio', true), provider('http', false), provider('carrier', true)]
    expect(chooseProvider(all, 'twilio', builtIn)?.id).toBe('twilio')
    expect(chooseProvider(all, 'http', builtIn)).toBeNull()
    expect(chooseProvider(all, 'gone', builtIn)).toBeNull()
    expect(chooseProvider(all, undefined, builtIn)).toBeNull()
  })

  it('for “another plugin’s”, uses the first ready one that isn’t the plugin’s own', () => {
    const all = [
      provider('twilio', true),
      provider('http', true),
      provider('asleep', false),
      provider('carrier', true),
    ]
    expect(chooseProvider(all, 'plugin', builtIn)?.id).toBe('carrier')
    expect(chooseProvider(all.slice(0, 3), 'plugin', builtIn)).toBeNull()
  })
})

describe('channels', () => {
  it('word a text with the code first, as phones show a message’s start', () => {
    expect(messageText({ code: '123456', minutes: 10, site: 'Shop', purpose: 'sign-in' })).toBe(
      '123456 is your Shop code. It works for 10 minutes.',
    )
  })

  it('send a text through the provider there is, and say when there is none', async () => {
    const sent: unknown[] = []
    const carrier: SmsProvider = {
      id: 'carrier',
      label: 'Carrier',
      ready: () => true,
      send: async (message) => void sent.push(message),
    }
    const message = { code: '123456', minutes: 5, site: 'Shop', purpose: 'contact' }
    const sms = smsChannel(() => carrier)
    expect(sms).toMatchObject({ id: 'sms', kind: 'phone' })
    expect(sms.ready()).toBe(true)
    await sms.send('+393331234567', message)
    expect(sent).toEqual([
      { to: '+393331234567', text: '123456 is your Shop code. It works for 5 minutes.' },
    ])
    const none = smsChannel(() => null)
    expect(none.ready()).toBe(false)
    await expect(none.send('+393331234567', message)).rejects.toThrow('No SMS provider')
  })

  it('email a code, and fail when the mail plugin does', async () => {
    const mails: unknown[] = []
    const email = emailChannel({
      canSend: () => true,
      send: async (message) => {
        mails.push(message)
        return mails.length === 1
      },
    })
    const message = { code: '123456', minutes: 10, site: 'Shop', purpose: 'sign-in' }
    await email.send('ada@example.com', message)
    expect(mails[0]).toMatchObject({ to: 'ada@example.com', subject: '[Shop] Your sign-in code' })
    await expect(email.send('ada@example.com', message)).rejects.toThrow('could not be sent')
  })

  it('normalise and mask an address by their kind', () => {
    expect(normalizeAddress('email', ' A@B.co ')).toBe('a@b.co')
    expect(normalizeAddress('phone', '+39 333 1234567')).toBe('+393331234567')
    expect(normalizeAddress('phone', 'a@b.co')).toBeNull()
    expect(maskAddress('email', 'ada@example.com')).toBe('a•••@example.com')
    expect(maskAddress('phone', '+393331234567')).toBe('the number ending in 67')
  })
})

describe('on a site', () => {
  it('texts go through Twilio once its settings are there', async () => {
    const calls: { url: string; body: Record<string, string> }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: Object.fromEntries(init.body as URLSearchParams) })
        return new Response('{}', { status: 201 })
      }),
    )
    try {
      const site = await bootOtp({
        settings: { 'otp.method_sms': true, 'otp.twilio_from': '+14155552671' },
        env: { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'token' },
      })
      expect(site.otp.channels()[1]).toMatchObject({ id: 'sms', ready: true })
      const ada = await site.person('ada@cms.test')
      const tested = await site.act(ada.cookie, 'test-message', {
        channel: 'sms',
        to: '+39 333 123 4567',
      })
      expect(tested.flash).toEqual({
        kind: 'notice',
        message: 'A Text message test was accepted for +393331234567.',
      })
      expect(calls[0]!.url).toContain('/Accounts/AC123/Messages.json')
      expect(calls[0]!.body).toMatchObject({ To: '+393331234567', From: '+14155552671' })
      expect(calls[0]!.body.Body).toBe('123456 is your Shop code. It works for 10 minutes.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the test message says why it failed, and needs a provider and a number', async () => {
    const none = await bootOtp({ settings: { 'otp.method_sms': true } })
    const ada = await none.person('ada@cms.test')
    const send = (site: typeof none, cookie: string, to: string, channel = 'sms') =>
      site.act(cookie, 'test-message', { channel, to })
    expect((await send(none, ada.cookie, '+393331234567')).flash?.message).toBe(
      'Text message has no provider that is fully set up. Finish it in Settings.',
    )
    expect((await send(none, ada.cookie, '333')).flash?.kind).toBe('error')
    // A way that is off, or that isn't one, sends nothing.
    expect((await send(none, ada.cookie, '+393331234567', 'whatsapp')).flash?.message).toBe(
      'That way isn’t turned on.',
    )
    expect((await send(none, ada.cookie, '+393331234567', 'email')).flash?.message).toBe(
      'That way isn’t turned on.',
    )

    const site = await bootOtp({ sms: true })
    const admin = await site.person('ada@cms.test')
    site.failing.sms = true
    expect((await send(site, admin.cookie, '+393331234567')).flash).toEqual({
      kind: 'error',
      message: 'The Text message test couldn’t be sent: the carrier is down',
    })
    // Only those who manage OTP may send one.
    const editor = await site.person('ed@cms.test', 'editor')
    expect((await send(site, editor.cookie, '+393331234567')).status).toBe(403)
  })

  it('texts go through a custom request once that is what Settings chooses', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response('{}', { status: 200 })
      }),
    )
    try {
      const site = await bootOtp({
        settings: {
          'otp.method_sms': true,
          'otp.sms_provider': 'http',
          'otp.sms_http_url': 'https://sms.example.com/v1/messages',
          'otp.sms_http_auth': 'headers',
          'otp.sms_http_headers': [{ name: 'X-Api-Key', value: 'env:MY_SMS_KEY' }],
          'otp.sms_http_body': 'template',
          'otp.sms_http_template': '{"dst":"{{to}}","text":"{{text}}"}',
        },
        env: { MY_SMS_KEY: 'k-123' },
      })
      expect(site.otp.channels()[1]).toMatchObject({ id: 'sms', ready: true })
      const ada = await site.person('ada@cms.test')
      await site.act(ada.cookie, 'start-channel', { channel: 'sms', to: '+393331234567' })
      expect(calls[0]!.url).toBe('https://sms.example.com/v1/messages')
      expect(calls[0]!.init.headers).toMatchObject({ 'X-Api-Key': 'k-123' })
      const body = JSON.parse(calls[0]!.init.body as string) as { dst: string; text: string }
      expect(body.dst).toBe('+393331234567')
      expect(body.text).toMatch(/^\d{6} is your Shop code/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
