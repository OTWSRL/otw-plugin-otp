import { definePlugin } from '@otwdesign/sdk'
import { describe, expect, it, vi } from 'vitest'
import { whatsAppChannel, type WhatsAppProvider } from '../src/channels'
import { GRAPH_VERSION, metaWhatsAppProvider, twilioWhatsAppProvider } from '../src/whatsapp'
import { bootOtp } from './fixtures'

function fakeFetch(status = 200, body: unknown = { messages: [{ id: 'wamid.1' }] }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

const MESSAGE = { to: '+393331234567', code: '482913' }

describe('WhatsApp’s Cloud API', () => {
  const settings = { phoneId: '106540352242922', token: 'EAAG-token', template: 'sign_in_code' }

  it('sends the authentication template, with the code for its text and for its button', async () => {
    const { fetcher, calls } = fakeFetch()
    const meta = metaWhatsAppProvider(() => settings, fetcher)
    expect(meta.ready()).toBe(true)
    await meta.send(MESSAGE)

    expect(calls[0]!.url).toBe(
      `https://graph.facebook.com/${GRAPH_VERSION}/106540352242922/messages`,
    )
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toEqual({
      authorization: 'Bearer EAAG-token',
      'content-type': 'application/json',
    })
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '393331234567',
      type: 'template',
      template: {
        name: 'sign_in_code',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '482913' }],
          },
        ],
      },
    })
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('uses the template’s language, and the version and address it’s given', async () => {
    const { fetcher, calls } = fakeFetch()
    await metaWhatsAppProvider(
      () => ({ ...settings, language: 'it', api: 'http://127.0.0.1:3497/', version: 'v30.0' }),
      fetcher,
    ).send(MESSAGE)
    expect(calls[0]!.url).toBe('http://127.0.0.1:3497/v30.0/106540352242922/messages')
    const body = JSON.parse(calls[0]!.init.body as string) as {
      template: { language: { code: string } }
    }
    expect(body.template.language.code).toBe('it')
  })

  it('isn’t ready until its phone number ID, token and template are all set', async () => {
    for (const missing of ['phoneId', 'token', 'template'] as const) {
      const meta = metaWhatsAppProvider(() => ({ ...settings, [missing]: undefined }))
      expect(meta.ready()).toBe(false)
      await expect(meta.send(MESSAGE)).rejects.toThrow('not all set')
    }
  })

  it('reports why Meta refused, for the log', async () => {
    const { fetcher } = fakeFetch(400, {
      error: { message: '(#132001) Template name does not exist in the translation', code: 132001 },
    })
    await expect(metaWhatsAppProvider(() => settings, fetcher).send(MESSAGE)).rejects.toThrow(
      'WhatsApp answered 400: (#132001) Template name does not exist in the translation (132001)',
    )
  })
})

describe('WhatsApp through Twilio', () => {
  const account = {
    accountSid: 'AC123',
    authToken: 'token',
    from: '+14155238886',
    contentSid: 'HX0123456789abcdef0123456789abcdef',
  }

  it('sends the content template to a whatsapp: address, with the code as its variable', async () => {
    const { fetcher, calls } = fakeFetch(201, { sid: 'SM1' })
    const twilio = twilioWhatsAppProvider(() => account, fetcher)
    expect(twilio.ready()).toBe(true)
    await twilio.send(MESSAGE)
    expect(calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('AC123:token').toString('base64')}`,
    )
    expect(Object.fromEntries(calls[0]!.init.body as URLSearchParams)).toEqual({
      To: 'whatsapp:+393331234567',
      From: 'whatsapp:+14155238886',
      ContentSid: 'HX0123456789abcdef0123456789abcdef',
      ContentVariables: '{"1":"482913"}',
    })
  })

  it('takes a sender written with its prefix, or a Messaging Service', async () => {
    const prefixed = fakeFetch(201)
    await twilioWhatsAppProvider(
      () => ({ ...account, from: 'whatsapp:+14155238886' }),
      prefixed.fetcher,
    ).send(MESSAGE)
    expect(Object.fromEntries(prefixed.calls[0]!.init.body as URLSearchParams).From).toBe(
      'whatsapp:+14155238886',
    )
    const service = fakeFetch(201)
    await twilioWhatsAppProvider(() => ({ ...account, from: 'MG999' }), service.fetcher).send(
      MESSAGE,
    )
    expect(Object.fromEntries(service.calls[0]!.init.body as URLSearchParams).From).toBe('MG999')
  })

  it('isn’t ready without the account, the sender and the template', async () => {
    for (const missing of ['accountSid', 'authToken', 'from', 'contentSid'] as const) {
      const twilio = twilioWhatsAppProvider(() => ({ ...account, [missing]: undefined }))
      expect(twilio.ready()).toBe(false)
      await expect(twilio.send(MESSAGE)).rejects.toThrow('not all set')
    }
  })
})

describe('the WhatsApp channel', () => {
  it('hands the provider the code, not a text: the template words it', async () => {
    const sent: unknown[] = []
    const provider: WhatsAppProvider = {
      id: 'fake',
      label: 'Fake',
      ready: () => true,
      send: async (message) => void sent.push(message),
    }
    const channel = whatsAppChannel(() => provider)
    expect(channel).toMatchObject({ id: 'whatsapp', label: 'WhatsApp', kind: 'phone' })
    await channel.send('+393331234567', {
      code: '482913',
      minutes: 10,
      site: 'Shop',
      purpose: 'sign-in',
    })
    expect(sent).toEqual([MESSAGE])
    const none = whatsAppChannel(() => null)
    expect(none.ready()).toBe(false)
    await expect(
      none.send('+393331234567', { code: '1', minutes: 1, site: 'Shop', purpose: 'x' }),
    ).rejects.toThrow('No WhatsApp provider')
  })
})

describe('on a site', () => {
  /** A site whose WhatsApp codes go to a provider another plugin adds, which keeps them. */
  async function withWhatsApp(extra: Parameters<typeof bootOtp>[0] = {}) {
    const sent: { to: string; code: string }[] = []
    const courier = definePlugin({
      id: 'courier',
      version: '1.0.0',
      requires: { otp: '^1.0.0' },
      setup(cms) {
        cms.registries.get('otp.whatsapp').add({
          id: 'courier',
          label: 'Courier',
          ready: () => true,
          send: async (message) => void sent.push(message),
        })
      },
    })
    const site = await bootOtp({
      ...extra,
      plugins: [courier],
      settings: {
        'otp.method_whatsapp': true,
        'otp.whatsapp_provider': 'plugin',
        ...extra.settings,
      },
    })
    return Object.assign(site, { sent })
  }

  it('is off until Settings turns it on', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    expect(site.otp.channels()[2]).toEqual({
      id: 'whatsapp',
      label: 'WhatsApp',
      kind: 'phone',
      ready: false,
    })
    const refused = await site.act(ada.cookie, 'start-channel', {
      channel: 'whatsapp',
      to: '+393331234567',
    })
    expect(refused.flash?.message).toBe('That way isn’t available on this site.')
  })

  it('is set up by confirming a number, then asked for after the password', async () => {
    const site = await withWhatsApp()
    const ada = await site.person('ada@cms.test')
    const started = await site.act(ada.cookie, 'start-channel', {
      channel: 'whatsapp',
      to: '+39 333 123 4567',
    })
    expect(started.flash?.message).toBe('We sent a code to the number ending in 67.')
    expect(site.sent.at(-1)).toMatchObject({ to: '+393331234567' })
    expect(site.sent.at(-1)!.code).toMatch(/^\d{6}$/)

    const done = await site.act(ada.cookie, 'confirm-channel', {
      channel: 'whatsapp',
      code: site.sent.at(-1)!.code,
    })
    expect(done.flash?.message).toBe(
      'Codes by whatsapp are on: you’ll be sent one when you sign in.',
    )

    site.wait(61)
    const held = await site.logIn('ada@cms.test')
    expect(await site.offered(held.hold)).toEqual(['whatsapp', 'backup'])
    expect(site.sent).toHaveLength(2)
    expect(
      (await site.verify(held.hold, 'whatsapp', site.sent.at(-1)!.code)).session,
    ).not.toBeNull()
  })

  it('goes through the Cloud API once its settings are there, and its test says what it sent', async () => {
    const calls: { url: string; body: { to: string; template: { name: string } } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) })
        return new Response('{}', { status: 200 })
      }),
    )
    try {
      const site = await bootOtp({
        settings: {
          'otp.method_whatsapp': true,
          'otp.whatsapp_phone_id': '106540352242922',
          'otp.whatsapp_template': 'sign_in_code',
        },
        env: { WHATSAPP_TOKEN: 'EAAG-token' },
      })
      expect(site.otp.channels()[2]).toMatchObject({ id: 'whatsapp', ready: true })
      const ada = await site.person('ada@cms.test')
      const tested = await site.act(ada.cookie, 'test-message', {
        channel: 'whatsapp',
        to: '+39 333 123 4567',
      })
      expect(tested.flash).toEqual({
        kind: 'notice',
        message: 'A WhatsApp test was accepted for +393331234567.',
      })
      expect(calls[0]!.url).toContain('/106540352242922/messages')
      expect(calls[0]!.body).toMatchObject({
        to: '393331234567',
        template: { name: 'sign_in_code' },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('comes after a text message and before email among a person’s ways', async () => {
    const site = await withWhatsApp({ sms: true })
    const ada = await site.person('ada@cms.test')
    await site.act(ada.cookie, 'start-channel', { channel: 'whatsapp', to: '+393331234567' })
    await site.act(ada.cookie, 'confirm-channel', {
      channel: 'whatsapp',
      code: site.sent.at(-1)!.code,
    })
    await site.act(ada.cookie, 'start-channel', { channel: 'email' })
    const emailed = /Your code is (\d{6})/.exec(site.inbox.at(-1)!.text)![1]!
    await site.act(ada.cookie, 'confirm-channel', { channel: 'email', code: emailed })
    site.wait(61)
    await site.act(ada.cookie, 'start-channel', { channel: 'sms', to: '+393331234567' })
    const texted = /^(\d{6})/.exec(site.texts.at(-1)!.text)![1]!
    await site.act(ada.cookie, 'confirm-channel', { channel: 'sms', code: texted })
    site.wait(61)
    const held = await site.logIn('ada@cms.test')
    expect(await site.offered(held.hold)).toEqual(['sms', 'whatsapp', 'email', 'backup'])
  })
})
