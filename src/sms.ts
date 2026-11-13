import type { SmsProvider } from './channels'

// The SMS providers the plugin brings: Twilio, and any service that takes an HTTP request.
// Another plugin adds its own to the `otp.sms` registry.

type Fetch = typeof fetch
const TIMEOUT_MS = 10_000
const TWILIO_API = 'https://api.twilio.com'

export interface TwilioConfig {
  /** The Account SID, `AC…`. */
  accountSid?: string
  /** The account's Auth Token; or, with `apiKey`, that key's secret. */
  authToken?: string
  /** An API key's SID, `SK…`, to sign in with instead of the account's own token. */
  apiKey?: string
  apiSecret?: string
  /** A Twilio number in E.164, a sender name, or a Messaging Service SID, `MG…`. */
  from?: string
  /** Twilio's address, for tests. */
  api?: string
}

/** Up to 200 characters of what a service answered, for the log. */
async function reason(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  try {
    const json = JSON.parse(body) as { message?: unknown; code?: unknown }
    if (typeof json.message === 'string') {
      return json.code === undefined ? json.message : `${json.message} (${String(json.code)})`
    }
  } catch {
    // Not JSON: the text itself says what happened.
  }
  return body.slice(0, 200) || response.statusText
}

/** Twilio's Programmable Messaging: `POST /2010-04-01/Accounts/{sid}/Messages.json`. */
export function twilioProvider(config: () => TwilioConfig, fetcher: Fetch = fetch): SmsProvider {
  const credentials = () => {
    const { accountSid, authToken, apiKey, apiSecret, from } = config()
    const user = apiKey && apiSecret ? apiKey : accountSid
    const password = apiKey && apiSecret ? apiSecret : authToken
    return accountSid && user && password && from ? { accountSid, user, password, from } : null
  }
  return {
    id: 'twilio',
    label: 'Twilio',
    ready: () => credentials() !== null,
    async send({ to, text }) {
      const twilio = credentials()
      if (!twilio) throw new Error('Twilio’s account SID, token and sender are not all set')
      const body = new URLSearchParams({ To: to, Body: text })
      // A Messaging Service picks the sender itself; otherwise the message is from one number.
      body.set(twilio.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', twilio.from)
      const base = (config().api || TWILIO_API).replace(/\/+$/, '')
      const response = await fetcher(
        `${base}/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${twilio.user}:${twilio.password}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        throw new Error(`Twilio answered ${response.status}: ${await reason(response)}`)
      }
    },
  }
}

export interface HttpSmsConfig {
  /** Where the request goes: your own endpoint, or an SMS gateway's. */
  url?: string
  /** Sent as `Authorization: Bearer …`, when set. */
  token?: string
}

/** Whether `value` is an address a request can go to. */
export function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * Any service with an HTTP endpoint: a `POST` with the JSON `{ "to", "text" }`, and a bearer
 * token when one is set. Any 2xx answer counts as sent.
 */
export function httpProvider(config: () => HttpSmsConfig, fetcher: Fetch = fetch): SmsProvider {
  return {
    id: 'http',
    label: 'HTTP request',
    ready: () => isHttpUrl(config().url ?? ''),
    async send({ to, text }) {
      const { url, token } = config()
      if (!url || !isHttpUrl(url)) throw new Error('The SMS endpoint’s URL is not set')
      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ to, text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`The SMS endpoint answered ${response.status}: ${await reason(response)}`)
      }
    },
  }
}
