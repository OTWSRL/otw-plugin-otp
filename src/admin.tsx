import { FormButton, FormField, FormTable, Notice } from '@otwdesign/admin-ui'
import { ActionError, defineAdmin, type User } from '@otwdesign/sdk'
import { messageText } from './channels'
import { APP } from './engine'
import otp, { internalsOf } from './index'
import { normalizePhone } from './addresses'
import { KEY_ENV } from './secrets'
import { TwoStepSection } from './section'

const MANAGE = 'otp.manage'
/** Every role has it: anyone signed in may set up their own two-step sign-in. */
const OWN = 'core.read'

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

/** "an app and Email", for a sentence about the ways someone has. */
export function listWays(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}

/**
 * The admin entry: each person's own two-step sign-in on their Profile, an administrator's reset
 * on Edit User, the Status page and the settings.
 */
export default defineAdmin(otp, (cms) => {
  const service = cms.services.get('otp')
  const { engine, policy, smsProvider, key } = internalsOf(service)
  /** A way as a sentence names it: "an authenticator app", "email", "text message". */
  const label = (method: string) =>
    method === APP
      ? 'an authenticator app'
      : (service.channels().find((way) => way.id === method)?.label ?? method).toLowerCase()

  // ── A person's own ───────────────────────────────────────────────────────────

  cms.slots.fill('admin.profile', {
    component: async ({ user }) => (
      <TwoStepSection
        overview={await engine.overview(user)}
        action={(name) => cms.admin.actionUrl(name)}
        look="admin"
      />
    ),
  })

  const own = (name: string, run: (user: User, form: FormData) => Promise<string | void>): void =>
    cms.admin.action({
      name,
      capability: OWN,
      handler: async ({ user, form }) => {
        const notice = await run(user, form)
        return notice ? { notice } : {}
      },
    })

  own('start-app', async (user) => engine.startApp(user))
  own('confirm-app', async (user, form) => {
    await engine.confirmApp(user, field(form, 'code'))
    return 'Your authenticator app is set up: you’ll be asked for its code when you sign in.'
  })
  own('start-channel', async (user, form) => {
    const sent = await engine.startChannel(user, field(form, 'channel'), field(form, 'to'))
    return `We sent a code to ${sent.to}.`
  })
  own('confirm-channel', async (user, form) => {
    const channel = field(form, 'channel')
    await engine.confirmChannel(user, channel, field(form, 'code'))
    return `Codes by ${label(channel)} are on: you’ll be sent one when you sign in.`
  })
  own('cancel-setup', async (user, form) => engine.cancelSetup(user, field(form, 'method')))
  own('remove-way', async (user, form) => {
    const method = field(form, 'method')
    await engine.remove(user, method, field(form, 'password'))
    return method === APP
      ? 'Your authenticator app was removed.'
      : `Codes by ${label(method)} were turned off.`
  })
  own('new-backup-codes', async (user) => {
    await engine.newBackupCodes(user)
    return 'New backup codes were made. The old ones no longer work.'
  })
  own('dismiss-backup-codes', async (user) => engine.dismissBackupCodes(user))
  own('forget-devices', async (user) => {
    await engine.forgetDevices(user.id)
    return 'Every browser will ask for a code again.'
  })

  // ── Someone else's: Edit User ────────────────────────────────────────────────

  cms.slots.fill('admin.user', {
    component: async ({ user, target }) => {
      if (!cms.auth.can(user, 'core.manage_users')) return null
      const { methods, backupCodes } = await service.status(target.id)
      const who = target.name || target.email
      return (
        <>
          <h2>Two-step sign-in</h2>
          <FormTable>
            <FormField
              label="Status"
              description={
                methods.length > 0
                  ? `Reset it if ${who} has lost their phone and their backup codes: they then sign in with their password alone, and can set it up again.`
                  : undefined
              }
            >
              {methods.length === 0 ? (
                <p>
                  {policy().requiredRoles.has(target.role)
                    ? `${who} hasn’t set up a way of their own; their role’s codes go to their email address.`
                    : `${who} hasn’t set it up.`}
                </p>
              ) : (
                <>
                  <p>
                    On, with {listWays(methods.map(label))}. {backupCodes} backup{' '}
                    {backupCodes === 1 ? 'code' : 'codes'} left.
                  </p>
                  <FormButton
                    action={cms.admin.actionUrl('reset-user')}
                    fields={{ user: target.id }}
                  >
                    Reset Two-Step Sign-In
                  </FormButton>
                </>
              )}
            </FormField>
          </FormTable>
        </>
      )
    },
  })

  cms.admin.action({
    name: 'reset-user',
    capability: 'core.manage_users',
    handler: async ({ form }) => {
      const target = await cms.users.get(field(form, 'user'))
      if (!target) throw new ActionError('That user no longer exists.')
      await engine.reset(target.id)
      return { notice: `Two-step sign-in was reset for ${target.name || target.email}.` }
    },
  })

  // ── Status and settings ──────────────────────────────────────────────────────

  cms.admin.page({
    name: 'status',
    path: '/',
    title: 'OTP',
    capability: MANAGE,
    menu: { label: 'Status', order: 10 },
    load: async () => ({
      stats: await engine.stats(),
      channels: service.channels(),
      policy: policy(),
      provider: smsProvider()?.label ?? null,
      smsOn: policy().allowed('sms'),
    }),
    component: ({ data: { stats, channels, policy: rules, provider, smsOn } }) => {
      const roles = [...rules.requiredRoles]
      return (
        <>
          {rules.disabled && (
            <Notice type="warning">
              <p>
                <code>OTP_DISABLED</code> is set on the server: nobody is asked for a code. Remove
                it once you’re back in.
              </p>
            </Notice>
          )}
          {key.problem && (
            <Notice type="error">
              <p>{key.problem}, so it isn’t used.</p>
            </Notice>
          )}
          <p>
            After a correct password, people who have set up two-step sign-in are asked for a code.{' '}
            <a href={cms.admin.url('/settings')}>Settings</a>
          </p>
          <FormTable>
            <FormField label="People using it">
              {stats.people === 0
                ? 'No one yet'
                : `${stats.people}: ${
                    Object.entries(stats.byMethod)
                      .map(([method, people]) => `${people} with ${label(method)}`)
                      .join(', ') || '—'
                  }`}
            </FormField>
            <FormField
              label="Must use it"
              description="People with these roles get codes by email until they set up a way of their own."
            >
              {roles.length > 0 ? roles.join(', ') : 'No role: each person decides'}
            </FormField>
            <FormField label="Authenticator app">
              {rules.allowed(APP) ? 'On' : 'Turned off in Settings'}
            </FormField>
            {channels.map((way) => (
              <FormField key={way.id} label={way.label}>
                {way.ready
                  ? way.id === 'sms' && provider
                    ? `Ready, through ${provider}`
                    : 'Ready'
                  : !rules.allowed(way.id)
                    ? 'Turned off in Settings'
                    : way.kind === 'email'
                      ? 'Needs a mail plugin, such as Mailer, to send email'
                      : 'Needs an SMS provider: set one up in Settings'}
              </FormField>
            ))}
            <FormField
              label="App secrets"
              description={
                key.encrypted
                  ? undefined
                  : `Set ${KEY_ENV} on the server, to 32 or more random characters, and new secrets are encrypted with it. Keep it: without it they can’t be read.`
              }
            >
              {key.encrypted
                ? `Encrypted with ${KEY_ENV}`
                : 'Stored as they are: a copy of the database could make codes'}
            </FormField>
          </FormTable>

          {smsOn && (
            <>
              <h2>Send a test message</h2>
              <form method="post" action={cms.admin.actionUrl('test-sms')}>
                <FormTable>
                  <FormField
                    label="Mobile number"
                    htmlFor="otp-test-to"
                    description="With its country code. It’s sent a short message through your SMS provider."
                  >
                    <input
                      id="otp-test-to"
                      name="to"
                      type="tel"
                      className="regular-text"
                      autoComplete="tel"
                      placeholder="+39 333 123 4567"
                      required
                    />
                  </FormField>
                </FormTable>
                <p className="submit">
                  <button type="submit" className="button">
                    Send Test Message
                  </button>
                </p>
              </form>
            </>
          )}

          <h2>Locked out?</h2>
          <p>
            Another administrator can reset someone’s two-step sign-in from Users, on that person’s
            Edit User screen. If no one can sign in, set <code>OTP_DISABLED=true</code> on the
            server and restart it: nobody is asked for a code until it’s removed.
          </p>
        </>
      )
    },
  })

  cms.admin.action({
    name: 'test-sms',
    capability: MANAGE,
    handler: async ({ form }) => {
      const to = normalizePhone(field(form, 'to'))
      if (!to) {
        throw new ActionError('Enter the number with its country code, such as +39 333 123 4567.')
      }
      const provider = smsProvider()
      if (!provider) throw new ActionError('No SMS provider is set up. Add one in Settings.')
      const site = cms.settings.get('site.title') || 'My Site'
      const text = messageText({ code: '123456', minutes: 10, site, purpose: 'test' })
      try {
        await provider.send({ to, text: `Test: ${text}` })
      } catch (error) {
        cms.logger.error('OTP: the test message could not be sent', {
          provider: provider.id,
          error,
        })
        const why = error instanceof Error ? error.message : 'see the server log'
        throw new ActionError(`${provider.label} couldn’t send it: ${why}`)
      }
      return { notice: `${provider.label} accepted a test message for ${to}.` }
    },
  })

  cms.admin.settingsPage({
    name: 'settings',
    path: '/settings',
    title: 'OTP Settings',
    capability: MANAGE,
    menu: { label: 'Settings', parent: 'otp', order: 20 },
  })
  cms.admin.settingsSection({
    name: 'who',
    page: 'otp.settings',
    title: 'Who is asked for a code',
    fields: ['otp.required_roles', 'otp.remember_days'],
  })
  cms.admin.settingsSection({
    name: 'ways',
    page: 'otp.settings',
    title: 'Ways to get a code',
    description: 'What people can set up for themselves, on their Profile and their account page.',
    order: 20,
    fields: ['otp.method_app', 'otp.method_email', 'otp.method_sms', 'otp.code_minutes'],
  })
  cms.admin.settingsSection({
    name: 'sms',
    page: 'otp.settings',
    title: 'Text messages',
    description:
      'Twilio, or any service that takes an HTTP request. Secrets come from the server’s environment.',
    order: 30,
    fields: [
      'otp.sms_provider',
      'otp.twilio_account_sid',
      'otp.twilio_auth_token',
      'otp.twilio_api_key',
      'otp.twilio_api_secret',
      'otp.twilio_from',
      'otp.sms_http_url',
      'otp.sms_http_token',
    ],
  })
  cms.admin.settingsSection({
    name: 'forms',
    page: 'otp.settings',
    title: 'Codes for forms',
    description: 'For the site’s own forms that check an email address or a phone number.',
    order: 40,
    fields: ['otp.hourly_limit'],
  })
})
