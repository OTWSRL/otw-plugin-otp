import {
  ActionError,
  definePlugin,
  type AdminIcon,
  type SelectSetting,
  type User,
} from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import {
  chooseProvider,
  emailChannel,
  smsChannel,
  type OtpChannel,
  type SmsProvider,
} from './channels'
import {
  APP,
  createEngine,
  SETUP,
  SIGN_IN,
  type Engine,
  type NoticeEvent,
  type Policy,
  type SentCode,
} from './engine'
import { migrations, TABLES } from './migrations'
import { createKeys, KEY_ENV, keyProblem } from './secrets'
import { TwoStepSection } from './section'
import { httpProvider, isHttpUrl, twilioProvider } from './sms'

export type { OtpChannel, OtpMessage, SmsProvider } from './channels'
export type { SentCode } from './engine'

/** A purpose forms on the site may ask for codes for, declared with `otp.purpose()`. */
export interface OtpPurpose {
  /** The channels its codes may go by. Defaults to `email` alone: text messages cost money. */
  channels?: readonly string[]
}

/** What other plugins ask of OTP, with `cms.services.get('otp')`. */
export interface OtpService {
  /**
   * Declares a purpose a form asks codes for, such as `contact`: only declared purposes can be
   * asked for from the browser. In `setup()`.
   */
  purpose(name: string, definition?: OtpPurpose): void
  /**
   * Sends a code to an email address or a phone number, within limits: one a minute and five an
   * hour to an address, and the site's hourly limit for forms. Throws an `ActionError` that
   * says why it couldn't.
   */
  send(input: { channel: string; to: string; purpose: string }): Promise<SentCode>
  /** Whether `code` is the one sent as `id`. Five wrong ones end that code. */
  check(id: string, code: string): Promise<boolean>
  /**
   * Whether the code sent as `id` was checked for this address and purpose, and uses that up.
   * Call it in the form's own handler, before trusting the address: it's true once.
   */
  consume(id: string, expected: { to: string; purpose: string }): Promise<boolean>
  /** The channels codes can go by, and whether each can send now. */
  channels(): { id: string; label: string; kind: OtpChannel['kind']; ready: boolean }[]
  /** The ways a person has set up for signing in, by id, and their unused backup codes. */
  status(userId: string): Promise<{ methods: string[]; backupCodes: number }>
}

declare module '@otwdesign/sdk' {
  interface Settings {
    /** Role ids whose people must use a code, separated by commas. */
    'otp.required_roles': string
    /** Days a browser can ask not to be asked again; `0` doesn't offer it. */
    'otp.remember_days': string
    /** Whether people may use an authenticator app. */
    'otp.method_app': boolean
    /** Whether people may get codes by email. */
    'otp.method_email': boolean
    /** Whether people may get codes by text message. */
    'otp.method_sms': boolean
    /** Minutes a sent code works for. */
    'otp.code_minutes': string
    /** Codes the site's forms and setups may send in an hour, per channel. */
    'otp.hourly_limit': string
    /** Which SMS provider sends text messages: `auto`, `twilio`, `http`. */
    'otp.sms_provider': string
    /** Twilio's Account SID. `TWILIO_ACCOUNT_SID` overrides it. */
    'otp.twilio_account_sid': string
    /** Twilio's Auth Token, from `TWILIO_AUTH_TOKEN` only. */
    'otp.twilio_auth_token': string
    /** A Twilio API key's SID, to use instead of the Auth Token. `TWILIO_API_KEY` overrides it. */
    'otp.twilio_api_key': string
    /** That API key's secret, from `TWILIO_API_SECRET` only. */
    'otp.twilio_api_secret': string
    /** The Twilio number, sender name or Messaging Service SID texts come from. */
    'otp.twilio_from': string
    /** The address the HTTP provider posts each text message to. */
    'otp.sms_http_url': string
    /** The bearer token sent with it, from `OTP_SMS_TOKEN` only. */
    'otp.sms_http_token': string
  }
  interface Services {
    /** One-time codes for any form, and what a person's two-step sign-in is set to. */
    otp: OtpService
  }
  interface Registries {
    /** The ways a code can be sent: `email` and `sms`, and what other plugins add. */
    'otp.channels': OtpChannel
    /** The services that deliver a text message: `twilio` and `http`, and what other plugins add. */
    'otp.sms': SmsProvider
  }
  interface Capabilities {
    /** See OTP's status, change its settings, and send a test message. */
    'otp.manage': true
  }
  interface Jobs {
    /** Daily: clears out codes sent over a day ago, and setups never finished. */
    'otp.cleanup': Record<string, never>
    /** Emails a person that their two-step sign-in changed. */
    'otp.notify': { userId: string; event: NoticeEvent }
  }
}

const DAY_SECONDS = 24 * 60 * 60
const ROLE = /^[a-z0-9_-]+$/
const BUILT_IN_PROVIDERS = ['twilio', 'http']

/** The role ids in Settings' list, whatever separates them. */
export function parseRoles(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean),
  )
}

const choice = (
  label: string,
  description: string,
  fallback: string,
  options: readonly [string, string][],
): SelectSetting => ({
  type: 'select',
  label,
  description,
  default: fallback,
  options: options.map(([value, text]) => ({ value, label: text })),
})

/** The plain words of each email a person gets about their own sign-in. */
export function noticeText(
  event: NoticeEvent,
  label: (method: string) => string,
): [string, string] {
  const unsure = 'If this wasn’t you, change your password now and check your account.'
  switch (event.kind) {
    case 'added':
      return [
        'Two-step sign-in: a way was added',
        `${label(event.method)} was set up for signing in to your account. ${unsure}`,
      ]
    case 'removed':
      return [
        'Two-step sign-in: a way was removed',
        `${label(event.method)} was removed from your account’s sign-in. ${unsure}`,
      ]
    case 'backup-used':
      return [
        'A backup code was used to sign in',
        `One of your backup codes was just used to sign in. You have ${event.left} left. ${unsure}`,
      ]
    case 'backup-new':
      return [
        'New backup codes were made',
        `New backup codes were made for your account; the old ones no longer work. ${unsure}`,
      ]
    case 'reset':
      return [
        'Your two-step sign-in was reset',
        'An administrator reset your two-step sign-in: you now sign in with your password alone. Set it up again from your profile.',
      ]
  }
}

/** A padlock, for the admin menu: drawn as a mask, so only its shape counts. */
const PADLOCK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M14 9V6a4 4 0 0 0-8 0v3H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1zM8 6a2 2 0 1 1 4 0v3H8V6z"/></svg>'
const ICON: AdminIcon = `data:image/svg+xml;base64,${Buffer.from(PADLOCK).toString('base64')}`

/** What `setup()` made, for the plugin's own admin entry. */
export interface Internals {
  engine: Engine
  policy(): Policy
  /** The SMS provider text messages go through now, or `null`. */
  smsProvider(): SmsProvider | null
  /** Whether app secrets are encrypted, and why a key that is set can't be used. */
  key: { encrypted: boolean; problem: string | null }
}

const internals = new WeakMap<OtpService, Internals>()

/** What `setup()` made on this site, by its service: for the admin entry, which has the same `cms`. */
export function internalsOf(service: OtpService): Internals {
  const made = internals.get(service)
  if (!made) throw new Error('OTP has not set up')
  return made
}

export default definePlugin({
  id: 'otp',
  version: '1.0.0',
  name: 'OTP',
  description:
    'Two-step sign-in with an authenticator app, email or text message, and one-time codes for any form.',
  icon: ICON,
  requires: { core: '^1.7.0' },
  migrations,
  settings: {
    'otp.required_roles': {
      type: 'text',
      label: 'Roles that must use a code',
      description:
        'Role ids separated by commas, such as administrator, editor. Until someone with one of these roles sets up a way of their own, their codes go to their email address. Empty leaves it to each person.',
      default: '',
      maxLength: 500,
      validate: (value) =>
        [...parseRoles(value)].every((role) => ROLE.test(role))
          ? null
          : 'Use role ids, such as administrator, separated by commas',
    },
    'otp.remember_days': choice(
      'Remember a browser',
      'Lets people tick “Don’t ask again on this device” when they enter a code.',
      '0',
      [
        ['0', 'Never: ask for a code at every sign-in'],
        ['7', 'For 7 days'],
        ['30', 'For 30 days'],
        ['90', 'For 90 days'],
      ],
    ),
    'otp.method_app': {
      type: 'boolean',
      label: 'Authenticator app',
      description: 'Codes from an app such as Google Authenticator, 1Password or Authy.',
      default: true,
    },
    'otp.method_email': {
      type: 'boolean',
      label: 'Email',
      description: 'Codes sent to the account’s email address. Needs a mail plugin.',
      default: true,
    },
    'otp.method_sms': {
      type: 'boolean',
      label: 'Text message',
      description:
        'Codes sent to a phone number the person confirms. Needs an SMS provider, below.',
      default: false,
    },
    'otp.code_minutes': choice(
      'A sent code works for',
      'Codes from an app change every 30 seconds whatever this says.',
      '10',
      [
        ['5', '5 minutes'],
        ['10', '10 minutes'],
        ['15', '15 minutes'],
      ],
    ),
    'otp.hourly_limit': {
      type: 'text',
      label: 'Codes forms may send an hour',
      description:
        'The most codes the site’s forms, and people setting up a way, are sent in an hour, by email and by text message each: a ceiling on what a flood of requests can cost. Signing in doesn’t count.',
      default: '100',
      maxLength: 6,
      validate: (value) => (/^\d+$/.test(value) ? null : 'Use a whole number'),
    },
    'otp.sms_provider': choice(
      'Send text messages through',
      'Automatic uses a provider another plugin added, then Twilio, then the HTTP request: the first that is set up.',
      'auto',
      [
        ['auto', 'Automatic'],
        ['twilio', 'Twilio'],
        ['http', 'An HTTP request'],
      ],
    ),
    'otp.twilio_account_sid': {
      type: 'text',
      label: 'Twilio Account SID',
      description: 'Starts with AC. From the Twilio Console.',
      env: 'TWILIO_ACCOUNT_SID',
      maxLength: 64,
    },
    'otp.twilio_auth_token': {
      type: 'secret',
      label: 'Twilio Auth Token',
      description: 'From the Twilio Console. Not needed with an API key.',
      env: 'TWILIO_AUTH_TOKEN',
    },
    'otp.twilio_api_key': {
      type: 'text',
      label: 'Twilio API key SID',
      description:
        'Starts with SK. Optional: a key of its own, which can be revoked, instead of the Auth Token.',
      env: 'TWILIO_API_KEY',
      maxLength: 64,
    },
    'otp.twilio_api_secret': {
      type: 'secret',
      label: 'Twilio API key secret',
      env: 'TWILIO_API_SECRET',
    },
    'otp.twilio_from': {
      type: 'text',
      label: 'Twilio sender',
      description:
        'A Twilio phone number with its country code (+14155552671), a sender name, or a Messaging Service SID (MG…).',
      env: 'TWILIO_FROM',
      maxLength: 64,
    },
    'otp.sms_http_url': {
      type: 'text',
      label: 'HTTP request URL',
      description:
        'For any other SMS service: each message is POSTed here as JSON, { "to": "+393331234567", "text": "…" }. Any 2xx answer counts as sent.',
      env: 'OTP_SMS_URL',
      maxLength: 500,
      validate: (value) =>
        value === '' || isHttpUrl(value) ? null : 'Use an http or https address',
    },
    'otp.sms_http_token': {
      type: 'secret',
      label: 'HTTP request token',
      description: 'Sent as “Authorization: Bearer …”.',
      env: 'OTP_SMS_TOKEN',
    },
  },

  uninstall: async ({ db }) => {
    for (const table of TABLES) await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`))
  },

  setup(cms) {
    const env = process.env
    const setting = cms.settings.get
    const allowed: Record<string, () => boolean> = {
      [APP]: () => setting('otp.method_app') !== false,
      email: () => setting('otp.method_email') !== false,
      sms: () => setting('otp.method_sms') === true,
    }
    const policy = (): Policy => ({
      disabled: ['1', 'true'].includes(env.OTP_DISABLED ?? ''),
      // A channel another plugin added is on unless that plugin says otherwise.
      allowed: (method) => allowed[method]?.() ?? true,
      requiredRoles: parseRoles(setting('otp.required_roles')),
      rememberDays: Number(setting('otp.remember_days') ?? 0) || 0,
      minutes: Number(setting('otp.code_minutes') ?? 10) || 10,
      hourlyLimit: Number(setting('otp.hourly_limit') ?? 100) || 0,
    })

    cms.auth.capability('otp.manage', { label: 'Manage OTP and its settings' })

    const providers = cms.registries.define('otp.sms')
    providers.add(
      twilioProvider(() => ({
        accountSid: setting('otp.twilio_account_sid'),
        authToken: setting('otp.twilio_auth_token'),
        apiKey: setting('otp.twilio_api_key'),
        apiSecret: setting('otp.twilio_api_secret'),
        from: setting('otp.twilio_from'),
        api: env.TWILIO_API_URL,
      })),
    )
    providers.add(
      httpProvider(() => ({
        url: setting('otp.sms_http_url'),
        token: setting('otp.sms_http_token'),
      })),
    )
    const smsProvider = () =>
      chooseProvider(providers.list(), setting('otp.sms_provider'), BUILT_IN_PROVIDERS)
    const channels = cms.registries.define('otp.channels')
    channels.add(emailChannel(cms.mail))
    channels.add(smsChannel(smsProvider))

    const site = () => setting('site.title') || 'My Site'
    const keys = createKeys(env[KEY_ENV])
    const engine = createEngine({
      db: () => cms.db,
      keys,
      channels: () => channels.list(),
      policy,
      cache: cms.cache,
      logger: cms.logger,
      site,
      checkPassword: (user, password) => cms.auth.checkPassword(user, password),
      // After the request, and only if what caused it was kept: a job is queued with the
      // transaction it's queued in.
      notify: async (userId, event) =>
        void (await cms.jobs.enqueue('otp.notify', { userId, event })),
    })

    cms.jobs.define('otp.cleanup', {
      label: 'Clear out old sign-in codes',
      everySeconds: DAY_SECONDS,
      handler: () => engine.cleanup(),
    })
    cms.jobs.define('otp.notify', {
      label: 'Email someone that their two-step sign-in changed',
      attempts: 3,
      handler: async ({ userId, event }) => {
        const user = await cms.users.get(userId)
        if (!user || !cms.mail.canSend()) return
        const label = (method: string) =>
          method === APP ? 'An authenticator app' : (channels.get(method)?.label ?? method)
        const [subject, text] = noticeText(event, label)
        const sent = await cms.mail.send({
          to: user.email,
          subject: `[${site()}] ${subject}`,
          text,
        })
        if (!sent) throw new Error('The email could not be sent')
      },
    })

    // The step itself. Core holds the sign-in, shows the screen and counts wrong codes.
    cms.auth.signInStep({
      methods: (user, context) => engine.signInMethods(user, context),
      send: (user, method) => engine.sendSignInCode(user, method),
      verify: (user, method, code) => engine.verifySignIn(user, method, code),
      rememberDays: () => policy().rememberDays,
      remember: (user, device, days) => engine.rememberDevice(user, device, days),
    })

    // Codes for any form.
    const purposes = new Map<string, readonly string[]>()
    const service: OtpService = {
      purpose(name, definition = {}) {
        if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
          throw new TypeError(`An OTP purpose is a short lowercase name: "${name}"`)
        }
        if (name === SIGN_IN || name === SETUP) {
          throw new TypeError(`"${name}" is OTP’s own purpose; choose another name`)
        }
        purposes.set(name, definition.channels ?? ['email'])
      },
      send: async (input) => {
        if (input.purpose === SIGN_IN || input.purpose === SETUP) {
          throw new ActionError('That purpose is not a form’s.')
        }
        return engine.send(input)
      },
      check: (id, code) => engine.check(id, code),
      consume: (id, expected) => engine.consume(id, expected),
      channels: () =>
        channels.list().map((way) => ({
          id: way.id,
          label: way.label,
          kind: way.kind,
          ready: policy().allowed(way.id) && way.ready(),
        })),
      status: (userId) => engine.statusOf(userId),
    }
    internals.set(service, {
      engine,
      policy,
      smsProvider,
      key: { encrypted: keys.encrypted, problem: keyProblem(env[KEY_ENV]) },
    })
    cms.services.provide('otp', service)

    /** The browser's side of a form's code: JSON in, JSON out, and only for declared purposes. */
    const json = async (request: Request): Promise<Record<string, unknown> | null> => {
      // A JSON body can't be posted across sites without a preflight, which nothing here answers.
      if (!request.headers.get('content-type')?.startsWith('application/json')) return null
      const body: unknown = await request.json().catch(() => null)
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
    }
    const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 320) : '')
    cms.routes.api({
      method: 'POST',
      path: '/send',
      handler: async (request) => {
        const body = await json(request)
        if (!body) return Response.json({ error: 'Send JSON.' }, { status: 415 })
        const purpose = text(body.purpose)
        const channel = text(body.channel) || 'email'
        if (!purposes.get(purpose)?.includes(channel)) {
          return Response.json({ error: 'Codes can’t be asked for that.' }, { status: 400 })
        }
        try {
          return Response.json(await engine.send({ channel, to: text(body.to), purpose }))
        } catch (error) {
          if (error instanceof ActionError) {
            return Response.json({ error: error.message }, { status: 400 })
          }
          throw error
        }
      },
    })
    cms.routes.api({
      method: 'POST',
      path: '/check',
      handler: async (request) => {
        const body = await json(request)
        if (!body) return Response.json({ error: 'Send JSON.' }, { status: 415 })
        return Response.json({ verified: await engine.check(text(body.id), text(body.code)) })
      },
    })

    // My Account › Two-step sign-in: the same section the admin's Profile shows.
    cms.slots.fill('account.sections', {
      component: async ({ user }: { user: User }) => (
        <TwoStepSection
          overview={await engine.overview(user)}
          action={(name) => cms.admin.actionUrl(name)}
          look="site"
        />
      ),
    })
  },
})
