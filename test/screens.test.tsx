import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { listWays } from '../src/admin'
import { qrPath } from '../src/qr'
import { TwoStepSection } from '../src/section'
import { bootOtp, emailedCode } from './fixtures'

const action = (name: string) => `/api/p/otp/actions/${name}`
const html = (element: ReactElement) => renderToStaticMarkup(element)

describe('the two-step sign-in section', () => {
  it('offers each way there is to someone who has none', async () => {
    const site = await bootOtp({ sms: true })
    const ada = await site.person('ada@cms.test')
    const page = html(
      <TwoStepSection
        overview={await site.engine.overview(ada.user)}
        action={action}
        look="admin"
      />,
    )
    expect(page).toContain('Off: you sign in with your password alone.')
    expect(page).toContain('action="/api/p/otp/actions/start-app"')
    expect(page).toContain('Send a code to a•••@cms.test')
    expect(page).toContain('placeholder="+39 333 123 4567"')
    expect(page).toContain('class="button"')
    // Nothing set up: no backup codes, no browsers.
    expect(page).not.toContain('Backup codes')
    expect(page).not.toContain('Remembered browsers')
  })

  it('leaves out a way the site can’t use', async () => {
    const site = await bootOtp({ mail: false })
    const ada = await site.person('ada@cms.test')
    const page = html(
      <TwoStepSection
        overview={await site.engine.overview(ada.user)}
        action={action}
        look="site"
      />,
    )
    expect(page).toContain('Authenticator app')
    expect(page).not.toContain('<h3>Email</h3>')
    expect(page).not.toContain('<h3>Text message</h3>')
    // On the site, the theme styles the buttons.
    expect(page).not.toContain('class="button"')
  })

  it('shows the QR code and the key while an app is being set up', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.act(ada.cookie, 'start-app')
    const overview = await site.engine.overview(ada.user)
    const page = html(<TwoStepSection overview={overview} action={action} look="admin" />)
    expect(page).toContain(
      '<svg class="otp-qr" role="img" aria-label="QR code for your authenticator app"',
    )
    expect(page).toContain(`<code>${overview.ways[0]!.secret}</code>`)
    expect(page).toContain('autoComplete="one-time-code"')
    expect(page).toContain('action="/api/p/otp/actions/confirm-app"')
    expect(page).toContain('action="/api/p/otp/actions/cancel-setup"')
  })

  it('shows new backup codes once, then how many are left, and a password to remove a way', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.withApp(ada)
    const overview = await site.engine.overview(ada.user)
    const page = html(<TwoStepSection overview={overview} action={action} look="admin" />)
    expect(page).toContain('On: after your password, you’re asked for a code.')
    expect(page).toContain('Save your backup codes')
    for (const code of overview.fresh!) expect(page).toContain(`<code>${code}</code>`)
    expect(page).toContain('You have 10 of 10 left.')
    expect(page).toContain('<summary>Remove</summary>')
    expect(page).toContain('autoComplete="current-password"')
    // The secret is never shown again.
    expect(page).not.toContain('<svg')

    await site.act(ada.cookie, 'dismiss-backup-codes')
    const later = html(
      <TwoStepSection
        overview={await site.engine.overview(ada.user)}
        action={action}
        look="admin"
      />,
    )
    expect(later).not.toContain('Save your backup codes')
    expect(later).not.toContain(overview.fresh![0]!)
  })

  it('tells someone whose role must use a code where their codes go', async () => {
    const site = await bootOtp({ settings: { 'otp.required_roles': 'administrator' } })
    const ada = await site.person('ada@cms.test')
    const page = html(
      <TwoStepSection
        overview={await site.engine.overview(ada.user)}
        action={action}
        look="admin"
      />,
    )
    expect(page).toContain('Until you set up a way of your own, codes are emailed to you.')
  })

  it('asks for the code while email is being set up, and says where it went', async () => {
    const site = await bootOtp()
    const ada = await site.person('ada@cms.test')
    await site.act(ada.cookie, 'start-channel', { channel: 'email' })
    const pending = html(
      <TwoStepSection
        overview={await site.engine.overview(ada.user)}
        action={action}
        look="site"
      />,
    )
    expect(pending).toContain('We sent a code to a•••@cms.test. Enter it to turn this on.')
    expect(pending).toContain('Send a new code')
    await site.act(ada.cookie, 'confirm-channel', {
      channel: 'email',
      code: emailedCode(site.inbox, 'ada@cms.test'),
    })
    const on = html(
      <TwoStepSection
        overview={await site.engine.overview(ada.user)}
        action={action}
        look="site"
      />,
    )
    expect(on).toContain('On: codes go to a•••@cms.test.')
  })
})

describe('the QR code', () => {
  it('is drawn as one path of dark squares, with a quiet border', () => {
    const { path, size } = qrPath('otpauth://totp/Shop:ada%40cms.test?secret=JBSWY3DPEHPK3PXP')
    // At least version 1's 21 modules, and four of border each side.
    expect(size).toBeGreaterThanOrEqual(29)
    expect(path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/)
    // The finder pattern's corner sits just inside the border.
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true)
    expect(qrPath('another address').path).not.toBe(path)
  })
})

describe('the admin’s screens', () => {
  const page = async (site: Awaited<ReturnType<typeof bootOtp>>, path: string) => {
    const { user } = await site.signIn()
    const resolved = await site.kernel.resolveAdminPage(path, {}, user)
    if (resolved.kind !== 'page') throw new Error(`${path} is ${resolved.kind}`)
    return html(<resolved.Component {...resolved.props} />)
  }

  it('show what’s set up, and what’s missing', async () => {
    const bare = await bootOtp({ mail: false })
    const status = await page(bare, '/admin/otp')
    expect(status).toContain('No one yet')
    expect(status).toContain('No role: each person decides')
    expect(status).toContain('Needs a mail plugin, such as Mailer, to send email')
    expect(status).toContain('Turned off in Settings')
    expect(status).toContain('Stored as they are: a copy of the database could make codes')
    expect(status).toContain('OTP_DISABLED=true')
    expect(status).not.toContain('Send a test message')

    const full = await bootOtp({
      sms: true,
      settings: { 'otp.required_roles': 'administrator' },
      env: { OTP_SECRET_KEY: 'a key of at least thirty-two characters' },
    })
    await full.withApp(await full.person('ada@cms.test'))
    const ready = await page(full, '/admin/otp')
    expect(ready).toContain('1: 1 with an authenticator app')
    expect(ready).toContain('administrator')
    expect(ready).toContain('Ready, through Carrier')
    expect(ready).toContain('Encrypted with OTP_SECRET_KEY')
    expect(ready).toContain('Send a test message')
  })

  it('warn while everyone is let in, and about a key too short to use', async () => {
    const site = await bootOtp({ env: { OTP_DISABLED: '1', OTP_SECRET_KEY: 'short' } })
    const status = await page(site, '/admin/otp')
    expect(status).toContain('nobody is asked for a code')
    expect(status).toContain('OTP_SECRET_KEY needs at least 32 characters, so it isn’t used.')
  })

  it('are for those who manage OTP, with the settings beside the status', async () => {
    const site = await bootOtp()
    const editor = await site.signIn('editor')
    expect((await site.kernel.resolveAdminPage('/admin/otp', {}, editor.user)).kind).toBe(
      'forbidden',
    )
    const admin = await site.signIn()
    const settings = await site.kernel.resolveAdminPage('/admin/otp/settings', {}, admin.user)
    expect(settings.kind).toBe('settings')
    if (settings.kind !== 'settings') return
    expect(settings.view.sections.map((section) => section.title)).toEqual([
      'Who is asked for a code',
      'Ways to get a code',
      'Text messages',
      'Codes for forms',
    ])
  })

  it('show whoever manages users someone’s two-step sign-in, with a reset once there is one', async () => {
    const site = await bootOtp({ settings: { 'otp.required_roles': 'editor' } })
    const ada = await site.person('ada@cms.test')
    const bob = await site.person('bob@cms.test', 'editor')
    const [Section] = site.kernel.slot('admin.user')
    const render = async (viewer = ada.user) =>
      html(<>{await Section!({ user: viewer, target: bob.user })}</>)

    expect(await render()).toContain(
      'bob@cms.test hasn’t set up a way of their own; their role’s codes go to their email address.',
    )
    expect(await render()).not.toContain('Reset Two-Step Sign-In')

    await site.withApp(bob)
    const on = await render()
    expect(on).toContain('On, with an authenticator app. 10 backup codes left.')
    expect(on).toContain('action="/api/p/otp/actions/reset-user"')
    expect(on).toContain(`value="${bob.user.id}"`)
    // Someone who can't manage users sees nothing of it.
    expect(await render(bob.user)).toBe('')
  })

  it('put a person’s own section on their Profile, and on their account page', async () => {
    // With text messages, so the section has a field: the mobile number.
    const site = await bootOtp({ sms: true })
    const ada = await site.person('ada@cms.test')
    const [Section] = site.kernel.slot('admin.profile')
    const profile = html(<>{await Section!({ user: ada.user })}</>)
    expect(profile).toContain('Two-step sign-in')
    expect(profile).toContain('class="button"')
    const [Account] = site.kernel.slot('account.sections')
    const account = html(<>{await Account!({ user: ada.user })}</>)
    expect(account).toContain('Two-step sign-in')
    expect(account).toContain('class="otp-field account-field"')
  })

  it('name ways in a sentence', () => {
    expect(listWays([])).toBe('')
    expect(listWays(['an authenticator app'])).toBe('an authenticator app')
    expect(listWays(['an authenticator app', 'email'])).toBe('an authenticator app and email')
    expect(listWays(['an authenticator app', 'text message', 'email'])).toBe(
      'an authenticator app, text message and email',
    )
  })
})
