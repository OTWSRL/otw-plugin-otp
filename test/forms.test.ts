import { definePlugin } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import { bootOtp, emailedCode, textedCode, wrong } from './fixtures'

/** A plugin with two forms that check an address: one by email, one by email or text. */
const forms = definePlugin({
  id: 'forms',
  version: '1.0.0',
  requires: { otp: '^1.0.0' },
  setup(cms) {
    const otp = cms.services.get('otp')
    otp.purpose('contact')
    otp.purpose('callback', { channels: ['email', 'sms'] })
  },
})

const boot = (options: Parameters<typeof bootOtp>[0] = {}) =>
  bootOtp({ ...options, plugins: [forms] })

describe('a form’s code, from the browser', () => {
  const send = (site: Awaited<ReturnType<typeof boot>>, body: unknown) =>
    site.request('POST', '/api/p/otp/send', { json: body })
  const check = async (site: Awaited<ReturnType<typeof boot>>, id: string, code: string) =>
    (await (await site.request('POST', '/api/p/otp/check', { json: { id, code } })).json()) as {
      verified: boolean
    }

  it('is sent to the address, checked, and used once by the form’s handler', async () => {
    const site = await boot()
    const response = await send(site, { purpose: 'contact', to: ' Vera@Example.com ' })
    expect(response.status).toBe(200)
    const sent = (await response.json()) as { id: string; to: string; expiresAt: string }
    expect(sent).toMatchObject({ to: 'v•••@example.com' })
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Date(sent.expiresAt).getTime() - Date.now()).toBe(10 * 60 * 1000)
    expect(site.inbox.at(-1)).toMatchObject({
      to: ['vera@example.com'],
      subject: '[Shop] Your code',
    })
    expect(site.inbox.at(-1)!.text).toContain('If you didn’t ask for it, ignore this email.')

    const code = emailedCode(site.inbox, 'vera@example.com')
    // Not yet checked: the form's handler can't use it.
    expect(await site.otp.consume(sent.id, { to: 'vera@example.com', purpose: 'contact' })).toBe(
      false,
    )
    expect(await check(site, sent.id, wrong(code))).toEqual({ verified: false })
    expect(await check(site, sent.id, code)).toEqual({ verified: true })
    // Checked again, as a double click does, it's still right.
    expect(await check(site, sent.id, code)).toEqual({ verified: true })

    // It proves that address for that purpose, and nothing else.
    expect(await site.otp.consume(sent.id, { to: 'mallory@example.com', purpose: 'contact' })).toBe(
      false,
    )
    expect(await site.otp.consume(sent.id, { to: 'vera@example.com', purpose: 'callback' })).toBe(
      false,
    )
    expect(await site.otp.consume(sent.id, { to: 'VERA@example.com', purpose: 'contact' })).toBe(
      true,
    )
    // Once.
    expect(await site.otp.consume(sent.id, { to: 'vera@example.com', purpose: 'contact' })).toBe(
      false,
    )
    expect(await check(site, sent.id, code)).toEqual({ verified: false })
  })

  it('is refused for a purpose no plugin declared, or a channel the purpose doesn’t allow', async () => {
    const site = await boot({ sms: true })
    for (const body of [
      { purpose: 'newsletter', to: 'vera@example.com' },
      { purpose: 'sign-in', to: 'vera@example.com' },
      { purpose: 'contact', channel: 'sms', to: '+393331234567' },
      { to: 'vera@example.com' },
    ]) {
      const response = await send(site, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Codes can’t be asked for that.' })
    }
    expect(site.inbox).toHaveLength(0)
    expect(site.texts).toHaveLength(0)
  })

  it('goes by text message where the purpose allows it', async () => {
    const site = await boot({ sms: true })
    const response = await send(site, {
      purpose: 'callback',
      channel: 'sms',
      to: '+39 333 123 4567',
    })
    const sent = (await response.json()) as { id: string; to: string }
    expect(sent.to).toBe('the number ending in 67')
    expect(await check(site, sent.id, textedCode(site.texts, '+393331234567'))).toEqual({
      verified: true,
    })
    expect(await site.otp.consume(sent.id, { to: '+393331234567', purpose: 'callback' })).toBe(true)
  })

  it('says what’s wrong with an address', async () => {
    const site = await boot({ sms: true })
    const email = await send(site, { purpose: 'contact', to: 'not an address' })
    expect(await email.json()).toEqual({ error: 'Enter a valid email address.' })
    const phone = await send(site, { purpose: 'callback', channel: 'sms', to: '333 1234567' })
    expect(await phone.json()).toEqual({
      error: 'Enter the number with its country code, such as +39 333 123 4567.',
    })
  })

  it('takes JSON only, which another site’s page can’t post', async () => {
    const site = await boot()
    const form = await site.request('POST', '/api/p/otp/send', {
      form: { purpose: 'contact', to: 'vera@example.com' },
    })
    expect(form.status).toBe(415)
    const text = await site.request('POST', '/api/p/otp/check', {
      body: '{"id":"x","code":"1"}',
      headers: { 'content-type': 'text/plain' },
    })
    expect(text.status).toBe(415)
    const broken = await site.request('POST', '/api/p/otp/send', {
      body: '{',
      headers: { 'content-type': 'application/json' },
    })
    expect(broken.status).toBe(415)
    expect(site.inbox).toHaveLength(0)
  })
})

describe('limits', () => {
  it('send one address a code a minute, and five an hour', async () => {
    const site = await boot()
    const send = () =>
      site.otp.send({ channel: 'email', to: 'vera@example.com', purpose: 'contact' })
    await send()
    await expect(send()).rejects.toThrow('Wait a minute before asking for another code.')
    for (let sent = 1; sent < 5; sent++) {
      site.wait(61)
      await send()
    }
    site.wait(61)
    await expect(send()).rejects.toThrow('Too many codes were sent there. Try again in an hour.')
    // Another address is its own.
    await site.otp.send({ channel: 'email', to: 'walt@example.com', purpose: 'contact' })
    site.wait(60 * 60)
    await send()
    expect(site.inbox.filter((mail) => mail.to.includes('vera@example.com'))).toHaveLength(6)
  })

  it('cap what forms send in an hour, whoever asks, without touching sign-ins', async () => {
    const site = await boot({
      settings: { 'otp.hourly_limit': '3', 'otp.required_roles': 'administrator' },
    })
    for (const name of ['a', 'b', 'c']) {
      await site.otp.send({ channel: 'email', to: `${name}@example.com`, purpose: 'contact' })
    }
    await expect(
      site.otp.send({ channel: 'email', to: 'd@example.com', purpose: 'contact' }),
    ).rejects.toThrow('Codes can’t be sent right now. Try again later.')
    expect(site.logger.entries.some((entry) => entry.message.includes('hourly limit'))).toBe(true)

    // Signing in is not a form: its code is sent.
    await site.person('ada@cms.test')
    const held = await site.logIn('ada@cms.test')
    expect(held.flash).toBeNull()
    expect(emailedCode(site.inbox, 'ada@cms.test')).toMatch(/^\d{6}$/)

    site.wait(60 * 60 + 1)
    await site.otp.send({ channel: 'email', to: 'd@example.com', purpose: 'contact' })
  })

  it('end a code after five wrong tries', async () => {
    const site = await boot()
    const sent = await site.otp.send({
      channel: 'email',
      to: 'vera@example.com',
      purpose: 'contact',
    })
    const code = emailedCode(site.inbox, 'vera@example.com')
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await site.otp.check(sent.id, wrong(code))).toBe(false)
    }
    expect(await site.otp.check(sent.id, code)).toBe(false)
  })

  it('end a code when it runs out, and its proof half an hour after it was checked', async () => {
    const site = await boot()
    const late = await site.otp.send({
      channel: 'email',
      to: 'vera@example.com',
      purpose: 'contact',
    })
    const first = emailedCode(site.inbox, 'vera@example.com')
    site.wait(10 * 60 + 1)
    expect(await site.otp.check(late.id, first)).toBe(false)

    const sent = await site.otp.send({
      channel: 'email',
      to: 'vera@example.com',
      purpose: 'contact',
    })
    expect(await site.otp.check(sent.id, emailedCode(site.inbox, 'vera@example.com'))).toBe(true)
    site.wait(31 * 60)
    expect(await site.otp.consume(sent.id, { to: 'vera@example.com', purpose: 'contact' })).toBe(
      false,
    )
  })

  it('never check a code that belongs to a sign-in', async () => {
    const site = await boot({ settings: { 'otp.required_roles': 'administrator' } })
    await site.person('ada@cms.test')
    await site.logIn('ada@cms.test')
    const code = emailedCode(site.inbox, 'ada@cms.test')
    const result = (await site.db.execute(`SELECT id FROM otp_challenges`)) as unknown as {
      rows: { id: string }[]
    }
    expect(await site.otp.check(result.rows[0]!.id, code)).toBe(false)
    await expect(
      site.otp.send({ channel: 'email', to: 'ada@cms.test', purpose: 'sign-in' }),
    ).rejects.toThrow('That purpose is not a form’s.')
  })
})

describe('the service', () => {
  it('lists the channels, and whether each can send', async () => {
    const off = await boot({ mail: false })
    expect(off.otp.channels()).toEqual([
      { id: 'email', label: 'Email', kind: 'email', ready: false },
      { id: 'sms', label: 'Text message', kind: 'phone', ready: false },
    ])
    await expect(
      off.otp.send({ channel: 'email', to: 'vera@example.com', purpose: 'contact' }),
    ).rejects.toThrow('Codes can’t be sent that way on this site.')

    const on = await boot({ sms: true })
    expect(on.otp.channels().map((channel) => channel.ready)).toEqual([true, true])
  })

  it('refuses a purpose with a name it can’t use', async () => {
    const bad = (name: string) =>
      definePlugin({
        id: 'bad',
        version: '1.0.0',
        requires: { otp: '^1.0.0' },
        setup: (cms) => cms.services.get('otp').purpose(name),
      })
    await expect(bootOtp({ plugins: [bad('Sign Up')] })).rejects.toThrow(
      'An OTP purpose is a short lowercase name',
    )
    await expect(bootOtp({ plugins: [bad('sign-in')] })).rejects.toThrow('OTP’s own purpose')
  })

  it('handles ids that aren’t ids', async () => {
    const site = await boot()
    expect(await site.otp.check('nope', '123456')).toBe(false)
    expect(await site.otp.consume('nope', { to: 'a@b.co', purpose: 'contact' })).toBe(false)
    expect(await site.otp.status('nope')).toEqual({ methods: [], backupCodes: 0 })
  })
})

describe('a channel another plugin adds', () => {
  it('can be set up and signed in with, like the plugin’s own', async () => {
    const sent: { to: string; code: string }[] = []
    const whatsapp = definePlugin({
      id: 'whatsapp',
      version: '1.0.0',
      requires: { otp: '^1.0.0' },
      setup(cms) {
        cms.registries.get('otp.channels').add({
          id: 'whatsapp',
          label: 'WhatsApp',
          kind: 'phone',
          ready: () => true,
          send: async (to, message) => void sent.push({ to, code: message.code }),
        })
      },
    })
    const site = await bootOtp({ plugins: [whatsapp] })
    const ada = await site.person('ada@cms.test')
    const started = await site.act(ada.cookie, 'start-channel', {
      channel: 'whatsapp',
      to: '+393331234567',
    })
    expect(started.flash?.kind).toBe('notice')
    const done = await site.act(ada.cookie, 'confirm-channel', {
      channel: 'whatsapp',
      code: sent.at(-1)!.code,
    })
    expect(done.flash?.message).toBe(
      'Codes by whatsapp are on: you’ll be sent one when you sign in.',
    )

    site.wait(61)
    const held = await site.logIn('ada@cms.test')
    expect(await site.offered(held.hold)).toEqual(['whatsapp', 'backup'])
    expect((await site.verify(held.hold, 'whatsapp', sent.at(-1)!.code)).session).not.toBeNull()
  })
})
