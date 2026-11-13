import { TEST_PASSWORD } from '@otwdesign/testing'
import { describe, expect, it } from 'vitest'
import otp, { noticeText, parseRoles } from '../src/index'
import { totp } from '../src/totp'
import { bootOtp, emailedCode } from './fixtures'

describe('roles that must use a code', () => {
  const settings = { 'otp.required_roles': 'Administrator, editor' }

  it('get codes by email until they set up a way of their own', async () => {
    const site = await bootOtp({ settings })
    const ada = await site.person('ada@cms.test')
    expect(await site.engine.overview(ada.user)).toMatchObject({
      required: true,
      on: true,
      fallback: true,
    })
    const held = await site.logIn('ada@cms.test')
    expect(held.session).toBeNull()
    // No way of their own, so no backup codes to offer either.
    expect(await site.offered(held.hold)).toEqual(['email'])
    expect(
      (await site.verify(held.hold, 'email', emailedCode(site.inbox, 'ada@cms.test'))).session,
    ).not.toBeNull()

    // Their own way takes over.
    const secret = await site.withApp(ada)
    expect(await site.engine.overview(ada.user)).toMatchObject({ on: true, fallback: false })
    site.wait(30)
    const next = await site.logIn('ada@cms.test')
    expect(await site.offered(next.hold)).toEqual(['app', 'backup'])
    expect((await site.verify(next.hold, 'app', totp(secret, Date.now()))).session).not.toBeNull()
  })

  it('leave other roles to decide for themselves', async () => {
    const site = await bootOtp({ settings })
    const cleo = await site.person('cleo@cms.test', 'customer')
    expect(await site.engine.overview(cleo.user)).toMatchObject({ required: false, on: false })
    expect((await site.logIn('cleo@cms.test')).session).not.toBeNull()
    expect(site.inbox).toHaveLength(0)
  })

  it('are let in, with a warning in the log, when the site can’t email a code', async () => {
    const site = await bootOtp({ settings, mail: false })
    const ada = await site.person('ada@cms.test')
    expect(await site.engine.overview(ada.user)).toMatchObject({ required: true, on: false })
    expect((await site.logIn('ada@cms.test')).session).not.toBeNull()
    expect(
      site.logger.entries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('no way to email one'),
      ),
    ).toBe(true)
  })

  it('reads the setting’s list however it’s separated', () => {
    expect([...parseRoles(' Administrator,editor  shop_manager ')]).toEqual([
      'administrator',
      'editor',
      'shop_manager',
    ])
    expect(parseRoles(undefined).size).toBe(0)
    const validate = (otp.settings!['otp.required_roles'] as { validate(value: string): unknown })
      .validate
    expect(validate('administrator, editor')).toBeNull()
    expect(validate('')).toBeNull()
    expect(validate('admin!')).toBe('Use role ids, such as administrator, separated by commas')
  })
})

describe('a password set from an emailed link', () => {
  const reset = async (site: Awaited<ReturnType<typeof bootOtp>>, email: string) => {
    await site.request('POST', '/api/p/core/actions/account-lost-password', { form: { email } })
    const token = /token=([\w-]+)/.exec(site.inbox.at(-1)!.text)![1]!
    const response = await site.request('POST', '/api/p/core/actions/account-reset', {
      form: { token, password: 'a brand new passphrase' },
    })
    const cookies = response.headers.get('set-cookie') ?? ''
    return {
      session: /cms_session=([^;]+)/.exec(cookies)?.[1] ?? null,
      hold: /cms_sign_in=([^;]+)/.exec(cookies)?.[1] ?? null,
    }
  }

  it('still asks for the app’s code: an inbox alone doesn’t open the account', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    const done = await reset(site, 'ada@cms.test')
    expect(done.session).toBeNull()
    expect(await site.offered(done.hold)).toEqual(['app', 'backup'])
  })

  it('doesn’t ask for a code by email: the link has just proved the inbox', async () => {
    const site = await bootOtp({ settings: { 'otp.required_roles': 'administrator' } })
    await site.person('ada@cms.test')
    const done = await reset(site, 'ada@cms.test')
    expect(done.session).not.toBeNull()
    expect(done.hold).toBeNull()
  })
})

describe('remembering a browser', () => {
  it('is offered for the days Settings says, and skips the code there until forgotten', async () => {
    const site = await bootOtp({ settings: { 'otp.remember_days': '30' } })
    const ada = await site.person('ada@cms.test')
    const secret = await site.withApp(ada)
    site.wait(30)
    const held = await site.logIn('ada@cms.test')
    expect((await site.kernel.signIns.held(held.hold, null))!.rememberDays).toBe(30)
    const done = await site.verify(held.hold, 'app', totp(secret, Date.now()), { remember: 'on' })
    expect(done.device).toMatch(/^[\w-]{43}$/)
    // Only its hash is kept.
    expect(await site.count('otp_devices')).toBe(1)
    expect(await site.count('otp_devices', `device_hash = '${done.device}'`)).toBe(0)
    expect((await site.engine.overview(ada.user)).devices).toBe(1)

    const device = `cms_device=${done.device}`
    expect((await site.logIn('ada@cms.test', device)).session).not.toBeNull()
    // Another person on the same browser is asked as ever.
    const bob = await site.person('bob@cms.test')
    await site.withApp(bob)
    expect((await site.logIn('bob@cms.test', device)).session).toBeNull()

    // Thirty days on, the browser is asked again.
    site.wait(31 * 24 * 60 * 60)
    expect((await site.logIn('ada@cms.test', device)).session).toBeNull()
  })

  it('ends when the person forgets their browsers', async () => {
    const site = await bootOtp({ settings: { 'otp.remember_days': '7' } })
    const ada = await site.person('ada@cms.test')
    const secret = await site.withApp(ada)
    site.wait(30)
    const held = await site.logIn('ada@cms.test')
    const done = await site.verify(held.hold, 'app', totp(secret, Date.now()), { remember: 'on' })
    const forgot = await site.act(ada.cookie, 'forget-devices')
    expect(forgot.flash?.message).toBe('Every browser will ask for a code again.')
    expect((await site.logIn('ada@cms.test', `cms_device=${done.device}`)).session).toBeNull()
  })

  it('isn’t offered unless Settings turns it on', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    const held = await site.logIn('ada@cms.test')
    expect((await site.kernel.signIns.held(held.hold, null))!.rememberDays).toBe(0)
  })
})

describe('removing a way', () => {
  it('asks for the password, and takes backup codes and browsers with the last one', async () => {
    const site = await bootOtp({ settings: { 'otp.remember_days': '30' } })
    const ada = await site.person('ada@cms.test')
    const secret = await site.withApp(ada)
    site.wait(30)
    const held = await site.logIn('ada@cms.test')
    await site.verify(held.hold, 'app', totp(secret, Date.now()), { remember: 'on' })

    const refused = await site.act(ada.cookie, 'remove-way', { method: 'app', password: 'not it' })
    expect(refused.flash).toEqual({ kind: 'error', message: 'Your password is incorrect.' })
    expect((await site.engine.overview(ada.user)).on).toBe(true)

    const removed = await site.act(ada.cookie, 'remove-way', {
      method: 'app',
      password: TEST_PASSWORD,
    })
    expect(removed.flash?.message).toBe('Your authenticator app was removed.')
    expect(await site.engine.overview(ada.user)).toMatchObject({
      on: false,
      backups: { left: 0, total: 0 },
      devices: 0,
      fresh: null,
    })
    expect((await site.logIn('ada@cms.test')).session).not.toBeNull()

    await site.runJobs()
    expect(site.inbox.at(-1)).toMatchObject({
      subject: '[Shop] Two-step sign-in: a way was removed',
    })
    expect(
      (await site.act(ada.cookie, 'remove-way', { method: 'app', password: TEST_PASSWORD })).flash,
    ).toEqual({ kind: 'error', message: 'That way isn’t set up.' })
  })

  it('keeps backup codes while another way remains', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    await site.act(ada.cookie, 'start-channel', { channel: 'email' })
    await site.act(ada.cookie, 'confirm-channel', {
      channel: 'email',
      code: emailedCode(site.inbox, 'ada@cms.test'),
    })
    const done = await site.act(ada.cookie, 'remove-way', {
      method: 'email',
      password: TEST_PASSWORD,
    })
    expect(done.flash?.message).toBe('Codes by email were turned off.')
    expect(await site.engine.overview(ada.user)).toMatchObject({ on: true, backups: { left: 10 } })
  })
})

describe('an administrator', () => {
  it('resets someone who is locked out, who is told by email', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    const bob = await site.person('bob@cms.test', 'editor')
    await site.withApp(bob)
    expect(await site.otp.status(bob.user.id)).toEqual({ methods: ['app'], backupCodes: 10 })

    const done = await site.act(ada.cookie, 'reset-user', { user: bob.user.id })
    expect(done.flash?.message).toBe('Two-step sign-in was reset for bob@cms.test.')
    expect(await site.otp.status(bob.user.id)).toEqual({ methods: [], backupCodes: 0 })
    expect((await site.logIn('bob@cms.test')).session).not.toBeNull()
    await site.runJobs()
    expect(site.inbox.at(-1)).toMatchObject({
      to: ['bob@cms.test'],
      subject: '[Shop] Your two-step sign-in was reset',
    })
  })

  it('is the only one who can: an editor is refused', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    const bob = await site.person('bob@cms.test', 'editor')
    const refused = await site.act(bob.cookie, 'reset-user', { user: ada.user.id })
    expect(refused.status).toBe(403)
    expect((await site.otp.status(ada.user.id)).methods).toEqual(['app'])
    const missing = await site.act(ada.cookie, 'reset-user', { user: 'nobody' })
    expect(missing.flash?.message).toBe('That user no longer exists.')
  })

  it('can let everyone in with OTP_DISABLED, when no one can get a code', async () => {
    const site = await bootOtp({ env: { OTP_DISABLED: 'true' } })
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    expect((await site.engine.overview(ada.user)).on).toBe(false)
    expect((await site.logIn('ada@cms.test')).session).not.toBeNull()
  })

  it('turns a way off for the whole site in Settings', async () => {
    const site = await bootOtp({ settings: { 'otp.method_app': false } })
    const ada = await site.person('ada@cms.test')
    expect((await site.act(ada.cookie, 'start-app')).flash?.message).toBe(
      'Authenticator apps are turned off.',
    )
    expect((await site.engine.overview(ada.user)).ways[0]).toMatchObject({ state: 'unavailable' })
  })
})

describe('what people are told', () => {
  it('names the way, and what to do if it wasn’t them', () => {
    const label = (method: string) => (method === 'app' ? 'An authenticator app' : 'Email')
    expect(noticeText({ kind: 'added', method: 'email' }, label)[1]).toMatch(
      /^Email was set up .* change your password now/,
    )
    expect(noticeText({ kind: 'removed', method: 'app' }, label)[1]).toContain(
      'An authenticator app was removed',
    )
    expect(noticeText({ kind: 'backup-used', left: 3 }, label)[1]).toContain('You have 3 left.')
    expect(noticeText({ kind: 'backup-new' }, label)[0]).toBe('New backup codes were made')
    expect(noticeText({ kind: 'reset' }, label)[1]).toContain('An administrator reset')
  })
})

describe('housekeeping', () => {
  it('clears out old codes, lapsed browsers and setups never finished, daily', async () => {
    const site = await bootOtp({ settings: { 'otp.required_roles': 'administrator' } })
    const ada = await site.person('ada@cms.test')
    await site.logIn('ada@cms.test')
    await site.act(ada.cookie, 'start-app')
    await site.engine.rememberDevice(ada.user, 'x'.repeat(43), 1)
    expect(await site.count('otp_challenges')).toBe(1)

    site.wait(2 * 24 * 60 * 60)
    await site.engine.cleanup()
    expect(await site.count('otp_challenges')).toBe(0)
    expect(await site.count('otp_devices')).toBe(0)
    expect(await site.count('otp_methods')).toBe(0)
  })

  it('has its clean-up in the site’s queue, a day apart', async () => {
    const site = await bootOtp()
    await site.runJobs()
    const { jobs } = await site.kernel.jobs.list({ status: 'pending' })
    expect(jobs.find((job) => job.name === 'otp.cleanup')).toMatchObject({ everySeconds: 86_400 })
  })

  it('drops its tables when its data is deleted', async () => {
    const site = await bootOtp()
    await otp.uninstall!({
      db: site.db,
      logger: site.logger,
      plugin: { id: 'otp', version: '1.0.0' },
    })
    for (const table of ['otp_methods', 'otp_backup_codes', 'otp_challenges', 'otp_devices']) {
      expect(await site.count('pg_tables', `tablename = '${table}'`)).toBe(0)
    }
  })

  it('takes a person’s rows with them when they’re deleted', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    await site.db.execute(`DELETE FROM cms_users WHERE id = '${ada.user.id}'`)
    expect(await site.count('otp_methods')).toBe(0)
    expect(await site.count('otp_backup_codes')).toBe(0)
  })
})
