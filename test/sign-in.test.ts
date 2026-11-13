import { describe, expect, it } from 'vitest'
import { totp } from '../src/totp'
import { bootOtp, emailedCode, textedCode, wrong } from './fixtures'

const KEY = 'a key of at least thirty-two characters'

describe('someone who hasn’t set it up', () => {
  it('signs in with their password alone', async () => {
    const site = await bootOtp()
    await site.person('ada@cms.test')
    const done = await site.logIn('ada@cms.test')
    expect(done.session).not.toBeNull()
    expect(done.hold).toBeNull()
  })
})

describe('an authenticator app', () => {
  it('is set up by scanning a code and typing what the app shows', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    expect((await site.engine.overview(ada.user)).on).toBe(false)

    await site.act(ada.cookie, 'start-app')
    const pending = (await site.engine.overview(ada.user)).ways[0]!
    expect(pending).toMatchObject({ id: 'app', state: 'pending', mine: false })
    expect(pending.secret).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/)
    const secret = pending.secret!.replace(/ /g, '')
    expect(pending.uri).toBe(
      `otpauth://totp/Shop:ada%40cms.test?secret=${secret}&issuer=Shop&algorithm=SHA1&digits=6&period=30`,
    )
    // Not on until confirmed: signing in still needs no code.
    expect((await site.logIn('ada@cms.test')).session).not.toBeNull()

    const code = totp(secret, Date.now())
    const bad = await site.act(ada.cookie, 'confirm-app', { code: wrong(code) })
    expect(bad.flash).toMatchObject({ kind: 'error' })
    expect(bad.flash!.message).toContain('That code isn’t right.')

    // Typed as the app shows it, in two groups.
    const good = await site.act(ada.cookie, 'confirm-app', {
      code: `${code.slice(0, 3)} ${code.slice(3)}`,
    })
    expect(good.flash).toEqual({
      kind: 'notice',
      message: 'Your authenticator app is set up: you’ll be asked for its code when you sign in.',
    })
    const overview = await site.engine.overview(ada.user)
    expect(overview).toMatchObject({ on: true, backups: { left: 10, total: 10 } })
    expect(overview.ways[0]).toMatchObject({ state: 'on', mine: true })
    expect(overview.ways[0]!.secret).toBeUndefined()
    // Backup codes come with the first way, shown this once.
    expect(overview.fresh).toHaveLength(10)
    expect(new Set(overview.fresh).size).toBe(10)

    await site.runJobs()
    expect(site.inbox.at(-1)).toMatchObject({
      to: ['ada@cms.test'],
      subject: '[Shop] Two-step sign-in: a way was added',
    })
    expect(site.inbox.at(-1)!.text).toContain('An authenticator app was set up')
  })

  it('is asked for after the password, and a code works once', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    const secret = await site.withApp(ada)

    const held = await site.logIn('ada@cms.test')
    expect(held).toMatchObject({ session: null, path: '/admin/login/verify' })
    expect(await site.offered(held.hold)).toEqual(['app', 'backup'])

    // The code that confirmed the app is used up: it doesn't also sign in.
    const setupCode = totp(secret, Date.now())
    expect((await site.verify(held.hold, 'app', setupCode)).session).toBeNull()

    site.wait(30)
    const code = totp(secret, Date.now())
    const refused = await site.verify(held.hold, 'app', wrong(code))
    expect(refused.session).toBeNull()
    expect(refused.flash?.message).toBe('That code isn’t right.')
    expect((await site.verify(held.hold, 'app', code)).session).not.toBeNull()

    // The same code, seen over a shoulder, doesn't sign anyone else in.
    const again = await site.logIn('ada@cms.test')
    expect((await site.verify(again.hold, 'app', code)).session).toBeNull()
    // The app's next code does.
    site.wait(30)
    expect((await site.verify(again.hold, 'app', totp(secret, Date.now()))).session).not.toBeNull()
  })

  it('can’t be set up twice, or confirmed before it’s started', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    expect((await site.act(ada.cookie, 'confirm-app', { code: '123456' })).flash?.message).toBe(
      'Start setting up your app first.',
    )
    await site.withApp(ada)
    expect((await site.act(ada.cookie, 'start-app')).flash?.message).toBe(
      'Your authenticator app is already set up.',
    )
  })

  it('keeps its secret encrypted when the site has a key, and as it is without one', async () => {
    const plain = await bootOtp()
    await plain.withApp(await plain.person('ada@cms.test'))
    expect(await plain.count('otp_methods', `secret LIKE 'plain.%'`)).toBe(1)

    const sealed = await bootOtp({ env: { OTP_SECRET_KEY: KEY } })
    const ada = await sealed.person('ada@cms.test')
    const secret = await sealed.withApp(ada)
    expect(await sealed.count('otp_methods', `secret LIKE 'v1.%'`)).toBe(1)
    expect(await sealed.count('otp_methods', `secret LIKE '%${secret}%'`)).toBe(0)
    const held = await sealed.logIn('ada@cms.test')
    expect(
      (await sealed.verify(held.hold, 'app', totp(secret, Date.now() + 30_000))).session,
    ).not.toBeNull()
  })

  it('stops working if the key is lost, and says so in the log', async () => {
    const site = await bootOtp({ env: { OTP_SECRET_KEY: KEY } })
    const ada = await site.person('ada@cms.test')
    const secret = await site.withApp(ada)
    process.env.OTP_SECRET_KEY = `${KEY} but another`
    await site.reboot()
    const held = await site.logIn('ada@cms.test')
    expect(
      (await site.verify(held.hold, 'app', totp(secret, Date.now() + 30_000))).session,
    ).toBeNull()
    expect(
      site.logger.entries.some((entry) => entry.message.includes('secret can’t be read')),
    ).toBe(true)
  })

  it('can be cancelled while it’s being set up', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.act(ada.cookie, 'start-app')
    await site.act(ada.cookie, 'cancel-setup', { method: 'app' })
    expect((await site.engine.overview(ada.user)).ways[0]).toMatchObject({ state: 'off' })
    expect(await site.count('otp_methods')).toBe(0)
  })
})

describe('backup codes', () => {
  it('sign in once each, and tell the person by email', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    const [first, second] = (await site.engine.overview(ada.user)).fresh!

    const held = await site.logIn('ada@cms.test')
    expect((await site.verify(held.hold, 'backup', 'not-a-code')).session).toBeNull()
    // However it's typed.
    expect(
      (await site.verify(held.hold, 'backup', first!.toUpperCase().replace('-', ' '))).session,
    ).not.toBeNull()
    expect((await site.engine.overview(ada.user)).backups).toEqual({ left: 9, total: 10 })

    const again = await site.logIn('ada@cms.test')
    expect((await site.verify(again.hold, 'backup', first!)).session).toBeNull()
    expect((await site.verify(again.hold, 'backup', second!)).session).not.toBeNull()

    await site.runJobs()
    const told = site.inbox.filter((mail) =>
      mail.subject.endsWith('A backup code was used to sign in'),
    )
    expect(told).toHaveLength(2)
    expect(told[0]!.text).toContain('You have 9 left.')
  })

  it('are kept only as hashes, and shown until the person says they’re saved', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    const fresh = (await site.engine.overview(ada.user)).fresh!
    expect(await site.count('otp_backup_codes', `code_hash ~ '^[0-9a-f]{64}$'`)).toBe(10)
    expect(
      await site.count('otp_backup_codes', `code_hash = '${fresh[0]!.replace('-', '')}'`),
    ).toBe(0)

    await site.act(ada.cookie, 'dismiss-backup-codes')
    expect((await site.engine.overview(ada.user)).fresh).toBeNull()
  })

  it('can be made anew, which ends the old ones', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    const old = (await site.engine.overview(ada.user)).fresh!
    const made = await site.act(ada.cookie, 'new-backup-codes')
    expect(made.flash?.message).toBe('New backup codes were made. The old ones no longer work.')
    const fresh = (await site.engine.overview(ada.user)).fresh!
    expect(fresh).toHaveLength(10)
    expect(fresh).not.toEqual(old)

    const held = await site.logIn('ada@cms.test')
    expect((await site.verify(held.hold, 'backup', old[0]!)).session).toBeNull()
    expect((await site.verify(held.hold, 'backup', fresh[0]!)).session).not.toBeNull()
  })

  it('need a way to stand in for', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    expect((await site.act(ada.cookie, 'new-backup-codes')).flash).toEqual({
      kind: 'error',
      message: 'Set up a way to get codes first: backup codes stand in for it.',
    })
  })
})

describe('codes by email', () => {
  it('are set up with a code sent to the account’s address', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    const started = await site.act(ada.cookie, 'start-channel', { channel: 'email' })
    expect(started.flash).toEqual({ kind: 'notice', message: 'We sent a code to a•••@cms.test.' })
    expect(site.inbox.at(-1)).toMatchObject({ to: ['ada@cms.test'], subject: '[Shop] Your code' })
    expect(site.inbox.at(-1)!.text).toContain('It works for 10 minutes.')
    const email = (await site.engine.overview(ada.user)).ways.find((way) => way.id === 'email')
    expect(email).toMatchObject({ state: 'pending', to: 'a•••@cms.test' })

    const code = emailedCode(site.inbox, 'ada@cms.test')
    expect(
      (await site.act(ada.cookie, 'confirm-channel', { channel: 'email', code: wrong(code) }))
        .flash,
    ).toMatchObject({ kind: 'error' })
    const done = await site.act(ada.cookie, 'confirm-channel', { channel: 'email', code })
    expect(done.flash?.message).toBe('Codes by email are on: you’ll be sent one when you sign in.')
    expect((await site.engine.overview(ada.user)).on).toBe(true)
    // The code that set it up is used: it doesn't also sign in.
    expect(await site.count('otp_challenges', 'consumed_at IS NULL')).toBe(0)
  })

  it('are sent after the password, and checked', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.act(ada.cookie, 'start-channel', { channel: 'email' })
    await site.act(ada.cookie, 'confirm-channel', {
      channel: 'email',
      code: emailedCode(site.inbox, 'ada@cms.test'),
    })
    await site.age('2 minutes')
    const before = site.inbox.length

    const held = await site.logIn('ada@cms.test')
    expect(held).toMatchObject({ session: null, flash: null })
    expect(await site.offered(held.hold)).toEqual(['email', 'backup'])
    expect(site.inbox).toHaveLength(before + 1)
    expect(site.inbox.at(-1)).toMatchObject({ subject: '[Shop] Your sign-in code' })
    expect(site.inbox.at(-1)!.text).toContain('someone else has your password')

    const code = emailedCode(site.inbox, 'ada@cms.test')
    expect((await site.verify(held.hold, 'email', wrong(code))).session).toBeNull()
    expect((await site.verify(held.hold, 'email', code)).session).not.toBeNull()
    // Used: the same code doesn't finish another sign-in.
    await site.age('2 minutes')
    const again = await site.logIn('ada@cms.test')
    expect((await site.verify(again.hold, 'email', code)).session).toBeNull()
  })

  it('stop working when they run out, and after five wrong tries', async () => {
    const site = await bootOtp({ settings: { 'otp.required_roles': 'administrator' } })
    await site.person('ada@cms.test')
    const held = await site.logIn('ada@cms.test')
    const code = emailedCode(site.inbox, 'ada@cms.test')
    await site.db.execute(`UPDATE otp_challenges SET expires_at = now() - interval '1 second'`)
    expect((await site.verify(held.hold, 'email', code)).session).toBeNull()

    // A code with five wrong tries against it is dead, even for the right one.
    await site.person('bob@cms.test')
    const bob = await site.logIn('bob@cms.test')
    const right = emailedCode(site.inbox, 'bob@cms.test')
    await site.db.execute(`UPDATE otp_challenges SET attempts = 5 WHERE address = 'bob@cms.test'`)
    expect((await site.verify(bob.hold, 'email', right)).session).toBeNull()
  })

  it('aren’t sent more than once a minute, or five times an hour', async () => {
    const site = await bootOtp({ settings: { 'otp.required_roles': 'administrator' } })
    await site.person('ada@cms.test')
    const held = await site.logIn('ada@cms.test')
    const cookie = `cms_sign_in=${held.hold}`
    const resend = async () => {
      const response = await site.request('POST', '/api/p/core/actions/sign-in-send', {
        form: { method: 'email' },
        cookie,
      })
      const url = new URL(response.headers.get('location')!, 'http://cms.test')
      return site.kernel.readFlash(url.searchParams.get('flash') ?? undefined)
    }
    expect(await resend()).toEqual({
      kind: 'error',
      message: 'Wait a minute before asking for another code.',
    })
    for (let sent = 1; sent < 5; sent++) {
      await site.age('2 minutes')
      expect((await resend())?.kind).toBe('notice')
    }
    await site.age('2 minutes')
    expect((await resend())?.message).toBe('Too many codes were sent there. Try again in an hour.')
    expect(site.inbox.filter((mail) => mail.subject.endsWith('Your sign-in code'))).toHaveLength(5)
    // An hour on, codes are sent again.
    await site.age('1 hour')
    expect((await resend())?.kind).toBe('notice')
  })

  it('say so when the email can’t be sent, and don’t count what wasn’t', async () => {
    const site = await bootOtp({ settings: { 'otp.required_roles': 'administrator' } })
    await site.person('ada@cms.test')
    site.failing.mail = true
    const held = await site.logIn('ada@cms.test')
    expect(held.hold).not.toBeNull()
    expect(held.flash?.message).toBe('We couldn’t send your code. Try again later.')
    expect(await site.count('otp_challenges')).toBe(0)
    expect(site.logger.entries.some((entry) => entry.message.includes('could not be sent'))).toBe(
      true,
    )
  })
})

describe('codes by text message', () => {
  const PHONE = '+393331234567'

  it('are set up by confirming a number, and sent there after the password', async () => {
    const site = await bootOtp({ sms: true })
    const ada = await site.person('ada@cms.test')
    const bad = await site.act(ada.cookie, 'start-channel', { channel: 'sms', to: '333 123 4567' })
    expect(bad.flash?.message).toBe(
      'Enter the number with its country code, such as +39 333 123 4567.',
    )
    const started = await site.act(ada.cookie, 'start-channel', {
      channel: 'sms',
      to: '+39 333 123 4567',
    })
    expect(started.flash?.message).toBe('We sent a code to the number ending in 67.')
    expect(site.texts.at(-1)).toMatchObject({ to: PHONE })
    expect(site.texts.at(-1)!.text).toMatch(/^\d{6} is your Shop code\. It works for 10 minutes\.$/)

    await site.act(ada.cookie, 'confirm-channel', {
      channel: 'sms',
      code: textedCode(site.texts, PHONE),
    })
    const sms = (await site.engine.overview(ada.user)).ways.find((way) => way.id === 'sms')
    expect(sms).toMatchObject({ state: 'on', to: 'the number ending in 67' })

    await site.age('2 minutes')
    const held = await site.logIn('ada@cms.test')
    expect(await site.offered(held.hold)).toEqual(['sms', 'backup'])
    expect(site.texts).toHaveLength(2)
    expect(
      (await site.verify(held.hold, 'sms', textedCode(site.texts, PHONE))).session,
    ).not.toBeNull()
  })

  it('must be confirmed with the code sent to the number being set up', async () => {
    const site = await bootOtp({ sms: true })
    const ada = await site.person('ada@cms.test')
    await site.act(ada.cookie, 'start-channel', { channel: 'sms', to: PHONE })
    const first = textedCode(site.texts, PHONE)
    // They change their mind about the number: the first number's code no longer confirms.
    await site.act(ada.cookie, 'start-channel', { channel: 'sms', to: '+14155552671' })
    const stale = await site.act(ada.cookie, 'confirm-channel', { channel: 'sms', code: first })
    expect(stale.flash?.kind).toBe('error')
    await site.act(ada.cookie, 'confirm-channel', {
      channel: 'sms',
      code: textedCode(site.texts, '+14155552671'),
    })
    expect(
      await site.count('otp_methods', `address = '+14155552671' AND confirmed_at IS NOT NULL`),
    ).toBe(1)
  })

  it('send a new code to the number being set up, without it being typed again', async () => {
    const site = await bootOtp({ sms: true })
    const ada = await site.person('ada@cms.test')
    await site.act(ada.cookie, 'start-channel', { channel: 'sms', to: PHONE })
    await site.age('2 minutes')
    const again = await site.act(ada.cookie, 'start-channel', { channel: 'sms' })
    expect(again.flash?.kind).toBe('notice')
    expect(site.texts.map((text) => text.to)).toEqual([PHONE, PHONE])
  })

  it('leave nothing half set up when the first text can’t be sent', async () => {
    const site = await bootOtp({ sms: true })
    const ada = await site.person('ada@cms.test')
    site.failing.sms = true
    const failed = await site.act(ada.cookie, 'start-channel', { channel: 'sms', to: PHONE })
    expect(failed.flash?.message).toBe('We couldn’t send your code. Try again later.')
    expect(await site.count('otp_methods')).toBe(0)
  })

  it('aren’t offered without a provider, or when turned off', async () => {
    const off = await bootOtp()
    const ada = await off.person('ada@cms.test')
    expect(
      (await off.act(ada.cookie, 'start-channel', { channel: 'sms', to: PHONE })).flash?.message,
    ).toBe('That way isn’t available on this site.')
    const sms = (await off.engine.overview(ada.user)).ways.find((way) => way.id === 'sms')
    expect(sms).toMatchObject({ state: 'unavailable', mine: false })
  })
})

describe('with several ways', () => {
  it('offers the app first, then the phone, then email, then a backup code', async () => {
    const site = await bootOtp({ sms: true })
    const ada = await site.person('ada@cms.test')
    await site.act(ada.cookie, 'start-channel', { channel: 'email' })
    await site.act(ada.cookie, 'confirm-channel', {
      channel: 'email',
      code: emailedCode(site.inbox, 'ada@cms.test'),
    })
    await site.act(ada.cookie, 'start-channel', { channel: 'sms', to: '+393331234567' })
    await site.act(ada.cookie, 'confirm-channel', {
      channel: 'sms',
      code: textedCode(site.texts, '+393331234567'),
    })
    await site.withApp(ada)
    await site.age('2 minutes')
    const texts = site.texts.length

    const held = await site.logIn('ada@cms.test')
    expect(await site.offered(held.hold)).toEqual(['app', 'sms', 'email', 'backup'])
    // The default, the app, sends nothing; the others send only when chosen.
    expect(site.texts).toHaveLength(texts)
  })
})
