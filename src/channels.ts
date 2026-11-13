import type { MailApi } from '@otwdesign/sdk'
import { maskEmail, maskPhone, normalizeEmail, normalizePhone } from './addresses'

/** A code on its way to someone, for a channel to word and send. */
export interface OtpMessage {
  code: string
  /** Minutes until the code stops working. */
  minutes: number
  /** The site's name. */
  site: string
  /** What the code is for: signing in, setting a way up, or a form's own purpose. */
  purpose: string
}

/**
 * A way to send someone a code. The plugin has `email` and `sms`; another plugin adds one, such
 * as WhatsApp, to the `otp.channels` registry, and people can then set it up and sign in with it.
 */
export interface OtpChannel {
  /** Such as `sms`: what the code's method is called everywhere. */
  id: string
  /** What people see: "Text message". */
  label: string
  /** `email`: codes go to the account's own address. `phone`: to a number the person gives. */
  kind: 'email' | 'phone'
  /** Whether it can send now: its keys are set, a mail plugin is active. */
  ready(): boolean
  /** Sends the code, or throws with a reason for the log. */
  send(to: string, message: OtpMessage): Promise<void>
}

/** A service that delivers a text message: Twilio, an HTTP gateway, or one a plugin adds. */
export interface SmsProvider {
  /** Such as `twilio`. */
  id: string
  /** What the status page calls it. */
  label: string
  /** Whether its keys are set. */
  ready(): boolean
  /** Delivers `text` to `to`, a number in E.164 (`+393331234567`), or throws with a reason. */
  send(message: { to: string; text: string }): Promise<void>
}

/** An address as its kind of channel keeps and compares it, or `null` when it isn't one. */
export function normalizeAddress(kind: OtpChannel['kind'], address: string): string | null {
  return kind === 'email' ? normalizeEmail(address) : normalizePhone(address)
}

/** An address as a screen shows it: recognisable to its owner, useless to anyone else. */
export function maskAddress(kind: OtpChannel['kind'], address: string): string {
  return kind === 'email' ? maskEmail(address) : maskPhone(address)
}

const SIGN_IN = 'sign-in'

/** The text of a code's message: short, the code first, as phones show the start of one. */
export function messageText({ code, minutes, site }: OtpMessage): string {
  return `${code} is your ${site} code. It works for ${minutes} minutes.`
}

/** Codes by email, through the site's mail plugin. */
export function emailChannel(mail: Pick<MailApi, 'send' | 'canSend'>): OtpChannel {
  return {
    id: 'email',
    label: 'Email',
    kind: 'email',
    ready: () => mail.canSend(),
    async send(to, message) {
      const signIn = message.purpose === SIGN_IN
      const sent = await mail.send({
        to,
        subject: `[${message.site}] Your ${signIn ? 'sign-in ' : ''}code`,
        text: [
          `Your code is ${message.code}.`,
          '',
          `It works for ${message.minutes} minutes.`,
          signIn
            ? 'If you didn’t just sign in, someone else has your password: change it now.'
            : 'If you didn’t ask for it, ignore this email.',
        ].join('\n'),
      })
      if (!sent) throw new Error('The email could not be sent')
    },
  }
}

/** Codes by text message, through whichever SMS provider the site uses. */
export function smsChannel(provider: () => SmsProvider | null): OtpChannel {
  return {
    id: 'sms',
    label: 'Text message',
    kind: 'phone',
    ready: () => provider() !== null,
    async send(to, message) {
      const active = provider()
      if (!active) throw new Error('No SMS provider is set up')
      await active.send({ to, text: messageText(message) })
    },
  }
}

/**
 * The provider text messages go through: the one Settings names, when it's ready; left on
 * automatic, one a plugin added, before Twilio and the HTTP gateway, whichever is ready first.
 */
export function chooseProvider(
  providers: readonly SmsProvider[],
  chosen: string | undefined,
  builtIn: readonly string[],
): SmsProvider | null {
  if (chosen && chosen !== 'auto') {
    const named = providers.find((provider) => provider.id === chosen)
    return named?.ready() ? named : null
  }
  const added = providers.filter((provider) => !builtIn.includes(provider.id))
  const own = providers.filter((provider) => builtIn.includes(provider.id))
  return [...added, ...own].find((provider) => provider.ready()) ?? null
}
