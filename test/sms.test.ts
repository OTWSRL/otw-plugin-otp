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
import { httpProvider, isHttpUrl, twilioProvider } from '../src/sms'
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
  it('posts the number and the text as JSON, with the token when there is one', async () => {
    const { fetcher, calls } = fakeFetch(200, 'ok')
    const http = httpProvider(
      () => ({ url: 'https://sms.example.com/send', token: 'abc' }),
      fetcher,
    )
    expect(http.ready()).toBe(true)
    await http.send(MESSAGE)
    expect(calls[0]!.url).toBe('https://sms.example.com/send')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer abc',
    })
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(MESSAGE)

    const bare = fakeFetch(204, '')
    await httpProvider(() => ({ url: 'https://sms.example.com/send' }), bare.fetcher).send(MESSAGE)
    expect(bare.calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('needs an http or https address', async () => {
    expect(isHttpUrl('https://sms.example.com/send')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:3496/sms')).toBe(true)
    for (const bad of ['', 'sms.example.com', 'ftp://example.com', 'javascript:alert(1)']) {
      expect(isHttpUrl(bad)).toBe(false)
      const http = httpProvider(() => ({ url: bad }))
      expect(http.ready()).toBe(false)
      await expect(http.send(MESSAGE)).rejects.toThrow('URL is not set')
    }
  })

  it('reports an answer that isn’t a 2xx', async () => {
    const { fetcher } = fakeFetch(401, { message: 'bad token' })
    await expect(
      httpProvider(() => ({ url: 'https://sms.example.com/send' }), fetcher).send(MESSAGE),
    ).rejects.toThrow('The SMS endpoint answered 401: bad token')
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

  it('on automatic, prefers one a plugin added, then Twilio, then the HTTP request', () => {
    const all = [provider('twilio', true), provider('http', true), provider('carrier', true)]
    expect(chooseProvider(all, 'auto', builtIn)?.id).toBe('carrier')
    expect(chooseProvider(all, undefined, builtIn)?.id).toBe('carrier')
    expect(chooseProvider(all.slice(0, 2), 'auto', builtIn)?.id).toBe('twilio')
    const notReady = [provider('twilio', false), provider('http', true), provider('carrier', false)]
    expect(chooseProvider(notReady, 'auto', builtIn)?.id).toBe('http')
    expect(chooseProvider([provider('twilio', false)], 'auto', builtIn)).toBeNull()
  })

  it('uses the one Settings names, or none while that one isn’t ready', () => {
    const all = [provider('twilio', true), provider('http', false), provider('carrier', true)]
    expect(chooseProvider(all, 'twilio', builtIn)?.id).toBe('twilio')
    expect(chooseProvider(all, 'http', builtIn)).toBeNull()
    expect(chooseProvider(all, 'gone', builtIn)).toBeNull()
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
      const tested = await site.act(ada.cookie, 'test-sms', { to: '+39 333 123 4567' })
      expect(tested.flash).toEqual({
        kind: 'notice',
        message: 'Twilio accepted a test message for +393331234567.',
      })
      expect(calls[0]!.url).toContain('/Accounts/AC123/Messages.json')
      expect(calls[0]!.body).toMatchObject({ To: '+393331234567', From: '+14155552671' })
      expect(calls[0]!.body.Body).toMatch(/^Test: 123456 is your Shop code/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the test message says why it failed, and needs a provider and a number', async () => {
    const none = await bootOtp()
    const ada = await none.person('ada@cms.test')
    expect((await none.act(ada.cookie, 'test-sms', { to: '+393331234567' })).flash?.message).toBe(
      'No SMS provider is set up. Add one in Settings.',
    )
    expect((await none.act(ada.cookie, 'test-sms', { to: '333' })).flash?.kind).toBe('error')

    const site = await bootOtp({ sms: true })
    const admin = await site.person('ada@cms.test')
    site.failing.sms = true
    const failed = await site.act(admin.cookie, 'test-sms', { to: '+393331234567' })
    expect(failed.flash).toEqual({
      kind: 'error',
      message: 'Carrier couldn’t send it: the carrier is down',
    })
    // Only those who manage OTP may send one.
    const editor = await site.person('ed@cms.test', 'editor')
    expect((await site.act(editor.cookie, 'test-sms', { to: '+393331234567' })).status).toBe(403)
  })
})
