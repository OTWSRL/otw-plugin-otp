import { definePlugin, type OutgoingMail, type PluginDefinition, type User } from '@otwdesign/sdk'
import { createTestKernel, TEST_PASSWORD, type TestKernel } from '@otwdesign/testing'
import { sql } from 'drizzle-orm'
import { afterEach, vi } from 'vitest'
import otp, { internalsOf } from '../src/index'
import otpAdmin from '../src/admin'
import { totp } from '../src/totp'

let open: TestKernel[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(open.map((harness) => harness.close()))
  open = []
})

export interface BootOptions {
  settings?: Parameters<typeof createTestKernel>[0]['settings']
  /** Whether the site has a mail plugin. Defaults to true. */
  mail?: boolean
  /** Whether the site has the tests' SMS provider. Defaults to false. */
  sms?: boolean
  plugins?: PluginDefinition[]
  env?: Record<string, string>
}

/** A site with OTP, a mail plugin that keeps its messages, and optionally an SMS provider that does. */
export async function bootOtp(options: BootOptions = {}) {
  for (const [name, value] of Object.entries(options.env ?? {})) vi.stubEnv(name, value)
  // The clock is the test's: ten seconds into one of an app's thirty-second steps, so a code
  // made and a code checked are never either side of a step by accident.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T12:00:10Z') })
  const inbox: OutgoingMail[] = []
  const texts: { to: string; text: string }[] = []
  const failing = { mail: false, sms: false }
  const mailer = definePlugin({
    id: 'mailer',
    version: '1.0.0',
    setup(cms) {
      cms.mail.transport({
        send: async (message) => {
          if (failing.mail) throw new Error('the mail server is down')
          inbox.push(message)
        },
      })
    },
  })
  const carrier = definePlugin({
    id: 'carrier',
    version: '1.0.0',
    requires: { otp: '^1.0.0' },
    setup(cms) {
      cms.registries.get('otp.sms').add({
        id: 'carrier',
        label: 'Carrier',
        ready: () => true,
        send: async (message) => {
          if (failing.sms) throw new Error('the carrier is down')
          texts.push(message)
        },
      })
    },
  })
  const harness = await createTestKernel({
    plugins: [
      ...(options.mail === false ? [] : [mailer]),
      otp,
      ...(options.sms ? [carrier] : []),
      ...(options.plugins ?? []),
    ],
    admin: [otpAdmin],
    settings: {
      'site.title': 'Shop',
      ...(options.sms ? { 'otp.method_sms': true } : {}),
      ...options.settings,
    },
    env: options.env,
  })
  open.push(harness)

  const service = () => harness.kernel.service('otp')
  const flashOf = (response: Response) => {
    const url = new URL(response.headers.get('location') ?? '', 'http://cms.test')
    return {
      path: url.pathname + url.search.replace(/[?&]flash=[^&]*/, ''),
      flash: harness.kernel.readFlash(url.searchParams.get('flash') ?? undefined),
    }
  }
  const cookieOf = (response: Response, name: string) =>
    new RegExp(`(?:^|, |\\b)${name}=([^;]*)`).exec(response.headers.get('set-cookie') ?? '')?.[1] ||
    null

  const extras = {
    inbox,
    texts,
    failing,
    get otp() {
      return service()
    },
    get engine() {
      return internalsOf(service()).engine
    },
    /** A user with a password, and a session to post their forms with. */
    async person(email: string, role = 'administrator') {
      const user = await harness.kernel.auth.createUser({ email, role, password: TEST_PASSWORD })
      const cookie = `cms_session=${await harness.kernel.auth.createSession(user.id)}`
      return { user, cookie }
    },
    /** Posts one of the plugin's own forms as someone. */
    async act(cookie: string, name: string, form: Record<string, string> = {}) {
      const response = await harness.request('POST', `/api/p/otp/actions/${name}`, { form, cookie })
      return { status: response.status, ...flashOf(response) }
    },
    /** The password step: a session at once, or a held sign-in waiting for a code. */
    async logIn(email: string, cookie = '') {
      const response = await harness.request('POST', '/api/p/core/actions/login', {
        form: { email, password: TEST_PASSWORD },
        ...(cookie ? { cookie } : {}),
      })
      return {
        session: cookieOf(response, 'cms_session'),
        hold: cookieOf(response, 'cms_sign_in'),
        ...flashOf(response),
      }
    },
    /** The code step of a held sign-in. */
    async verify(
      hold: string | null,
      method: string,
      code: string,
      extra: Record<string, string> = {},
    ) {
      const response = await harness.request('POST', '/api/p/core/actions/sign-in-verify', {
        form: { method, code, ...extra },
        cookie: `cms_sign_in=${hold ?? ''}`,
      })
      return {
        session: cookieOf(response, 'cms_session'),
        device: cookieOf(response, 'cms_device'),
        ...flashOf(response),
      }
    },
    /** The ways a held sign-in offers, by id. */
    async offered(hold: string | null) {
      const held = await harness.kernel.signIns.held(hold, null)
      return held?.methods.map((method) => method.id) ?? null
    },
    /** Sets an authenticator app up for someone, and returns its secret. */
    async withApp(person: { user: User; cookie: string }) {
      await this.act(person.cookie, 'start-app')
      const overview = await this.engine.overview(person.user)
      const secret = overview.ways[0]!.secret!.replace(/ /g, '')
      await this.act(person.cookie, 'confirm-app', { code: totp(secret, Date.now()) })
      return secret
    },
    /** Lets time pass. */
    wait(seconds: number) {
      vi.setSystemTime(Date.now() + seconds * 1000)
    },
    /** Runs the jobs that are due: the emails people get about their sign-in. */
    runJobs: () => harness.kernel.jobs.runDue(),
    /** Moves every sent code back in time, so limits that count recent ones let the next through. */
    async age(interval: string) {
      await harness.db.execute(
        sql.raw(`UPDATE otp_challenges SET created_at = created_at - interval '${interval}'`),
      )
    },
    async count(table: string, where = 'true') {
      const result = (await harness.db.execute(
        sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
      )) as unknown as { rows: { n: number }[] }
      return result.rows[0]!.n
    },
  }
  // Defined, not assigned: `otp` and `engine` are read anew after a reboot.
  return Object.defineProperties(harness, Object.getOwnPropertyDescriptors(extras)) as TestKernel &
    typeof extras
}

export type OtpSite = Awaited<ReturnType<typeof bootOtp>>

/** The six digits in the newest email to an address. */
export function emailedCode(inbox: readonly OutgoingMail[], to: string): string {
  const mail = inbox.findLast((message) => message.to.includes(to) && /code is/.test(message.text))
  const code = /Your code is (\d{6})\./.exec(mail?.text ?? '')?.[1]
  if (!code) throw new Error(`No code was emailed to ${to}`)
  return code
}

/** The six digits in the newest text message to a number. */
export function textedCode(texts: readonly { to: string; text: string }[], to: string): string {
  const code = /^(\d{6}) is your/.exec(texts.findLast((text) => text.to === to)?.text ?? '')?.[1]
  if (!code) throw new Error(`No code was texted to ${to}`)
  return code
}

/** A code that isn't `code`. */
export function wrong(code: string): string {
  return code === '000000' ? '111111' : '000000'
}
