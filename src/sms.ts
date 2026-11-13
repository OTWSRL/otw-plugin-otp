import type { SmsProvider } from './channels'

// The SMS providers the plugin brings: Twilio, and any service that takes an HTTP request.
// Another plugin adds its own to the `otp.sms` registry.

export type Fetch = typeof fetch
export const TIMEOUT_MS = 10_000
const TWILIO_API = 'https://api.twilio.com'

/** A Twilio account, as its settings and the environment give it. */
export interface TwilioAccount {
  /** The Account SID, `AC…`. */
  accountSid?: string
  /** The account's Auth Token; or, with `apiKey`, that key's secret. */
  authToken?: string
  /** An API key's SID, `SK…`, to sign in with instead of the account's own token. */
  apiKey?: string
  apiSecret?: string
  /** Twilio's address, for tests. */
  api?: string
}

export interface TwilioConfig extends TwilioAccount {
  /** A Twilio number in E.164, a sender name, or a Messaging Service SID, `MG…`. */
  from?: string
}

/** Up to 200 characters of what a service answered, for the log. */
export async function reason(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  try {
    const json = JSON.parse(body) as { message?: unknown; code?: unknown; error?: unknown }
    // Twilio answers `{ message, code }`; Meta's Graph API nests the same under `error`.
    const said = (typeof json.error === 'object' && json.error !== null ? json.error : json) as {
      message?: unknown
      code?: unknown
    }
    if (typeof said.message === 'string') {
      return said.code === undefined ? said.message : `${said.message} (${String(said.code)})`
    }
  } catch {
    // Not JSON: the text itself says what happened.
  }
  return body.slice(0, 200) || response.statusText
}

/** What signs a request in to Twilio and where it goes, or `null` while something is missing. */
export function twilioAccess(account: TwilioAccount) {
  const { accountSid, authToken, apiKey, apiSecret } = account
  const user = apiKey && apiSecret ? apiKey : accountSid
  const password = apiKey && apiSecret ? apiSecret : authToken
  if (!accountSid || !user || !password) return null
  const base = (account.api || TWILIO_API).replace(/\/+$/, '')
  return {
    url: `${base}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  }
}

/** Posts one message to Twilio's Messages API, and throws with Twilio's reason if it refuses. */
export async function twilioSend(
  access: NonNullable<ReturnType<typeof twilioAccess>>,
  fields: Record<string, string>,
  fetcher: Fetch,
): Promise<void> {
  const response = await fetcher(access.url, {
    method: 'POST',
    headers: {
      authorization: access.authorization,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Twilio answered ${response.status}: ${await reason(response)}`)
  }
}

/** Twilio's Programmable Messaging: `POST /2010-04-01/Accounts/{sid}/Messages.json`. */
export function twilioProvider(config: () => TwilioConfig, fetcher: Fetch = fetch): SmsProvider {
  const ready = () => {
    const { from, ...account } = config()
    const access = twilioAccess(account)
    return access && from ? { access, from } : null
  }
  return {
    id: 'twilio',
    label: 'Twilio',
    ready: () => ready() !== null,
    async send({ to, text }) {
      const twilio = ready()
      if (!twilio) throw new Error('Twilio’s account SID, token and sender are not all set')
      // A Messaging Service picks the sender itself; otherwise the message is from one number.
      const sender = twilio.from.startsWith('MG') ? 'MessagingServiceSid' : 'From'
      await twilioSend(twilio.access, { To: to, Body: text, [sender]: twilio.from }, fetcher)
    },
  }
}

// ── Any service, over HTTP ───────────────────────────────────────────────────

/** One header of a custom request. A value `env:NAME` is read from the environment. */
export interface HttpHeader {
  name: string
  value: string
}

export interface HttpSmsConfig {
  /** Where the request goes. It may hold `{{to}}` and `{{text}}`, for services that take a GET. */
  url?: string
  method?: string
  /** `bearer` sends `token`; `headers` sends `headers`; `none` sends neither. */
  auth?: string
  /** Sent as `Authorization: Bearer …`, with `bearer`. */
  token?: string
  headers?: readonly HttpHeader[]
  /** `json` and `form` send `to` and `text`; `template` sends `template`, filled in. */
  body?: string
  template?: string
  /** The template's content type, which also says how its placeholders are escaped. */
  contentType?: string
  /** Where `env:NAME` header values are read from. */
  env?: Readonly<Record<string, string | undefined>>
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
/** Headers the request sets itself, or that would change where and how it's sent. */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection'])
const ENV_REFERENCE = /^env:([A-Z][A-Z0-9_]*)$/

/** Why a set of custom headers can't be used, or `null`. */
export function headersProblem(headers: readonly HttpHeader[]): string | null {
  for (const { name, value } of headers) {
    if (!HEADER_NAME.test(name)) return `"${name}" isn’t a header name`
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) return `${name} is set by the request itself`
    // A line break would start another header, or the body.
    if (/[\r\n\0]/.test(value)) return `The value of ${name} must be one line`
    if (value.startsWith('env:') && !ENV_REFERENCE.test(value)) {
      return `${name}: after "env:" comes an environment variable’s name, such as env:SMS_API_KEY`
    }
  }
  return null
}

/** Whether `value` is an address a request can go to. */
export function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

type Encode = (value: string) => string

/** How a placeholder's value is written into a body of this content type, so it stays a value. */
export function encoderFor(contentType: string): Encode {
  const type = contentType.toLowerCase()
  if (type.includes('json')) return (value) => JSON.stringify(value).slice(1, -1)
  if (type.includes('x-www-form-urlencoded')) return encodeURIComponent
  if (type.includes('xml')) {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    }
    return (value) => value.replace(/[&<>"']/g, (char) => entities[char]!)
  }
  return (value) => value
}

/** A template with `{{to}}` and `{{text}}` filled in, each escaped for where it lands. */
export function fill(
  template: string,
  values: { to: string; text: string },
  encode: Encode,
): string {
  return template.replace(/\{\{\s*(to|text)\s*\}\}/g, (_, name: 'to' | 'text') =>
    encode(values[name]),
  )
}

/** The request's own headers: the token, or the custom ones with their `env:` values read. */
function requestHeaders(config: HttpSmsConfig): Record<string, string> {
  if (config.auth === 'none') return {}
  if (config.auth !== 'headers') {
    return config.token ? { authorization: `Bearer ${config.token}` } : {}
  }
  const headers = config.headers ?? []
  const problem = headersProblem(headers)
  if (problem) throw new Error(problem)
  return Object.fromEntries(
    headers.map(({ name, value }) => {
      const variable = ENV_REFERENCE.exec(value)?.[1]
      if (!variable) return [name, value]
      const read = (config.env ?? {})[variable]
      // Named, never printed: the log says which variable is missing, not what a header holds.
      if (!read) throw new Error(`The header ${name} reads ${variable}, which isn’t set`)
      return [name, read]
    }),
  )
}

/** What's wrong with an HTTP provider's settings, or `null` when a request can be made. */
export function httpProblem(config: HttpSmsConfig): string | null {
  if (!config.url || !isHttpUrl(config.url)) return 'The request’s URL is not set'
  if (config.body === 'template' && config.method !== 'GET' && !config.template?.trim()) {
    return 'The request’s body template is empty'
  }
  try {
    requestHeaders(config)
  } catch (error) {
    return (error as Error).message
  }
  return null
}

/**
 * Any service with an HTTP endpoint. By default a `POST` of the JSON `{ "to", "text" }`, with a
 * bearer token when one is set. Or a request of your own: its method, its headers, and a body
 * as a form or from a template. Any 2xx answer counts as sent.
 */
export function httpProvider(config: () => HttpSmsConfig, fetcher: Fetch = fetch): SmsProvider {
  return {
    id: 'http',
    label: 'HTTP request',
    ready: () => httpProblem(config()) === null,
    async send(message) {
      const settings = config()
      const problem = httpProblem(settings)
      if (problem) throw new Error(problem)
      const headers = requestHeaders(settings)
      const get = settings.method === 'GET'
      let body: string | undefined
      if (!get) {
        const kind = settings.body ?? 'json'
        const type =
          kind === 'form'
            ? 'application/x-www-form-urlencoded'
            : kind === 'template'
              ? settings.contentType?.trim() || 'application/json'
              : 'application/json'
        body =
          kind === 'form'
            ? new URLSearchParams({ to: message.to, text: message.text }).toString()
            : kind === 'template'
              ? fill(settings.template ?? '', message, encoderFor(type))
              : JSON.stringify(message)
        // A custom Content-Type header, if there is one, has the last word.
        if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
          headers['content-type'] = type
        }
      }
      const response = await fetcher(fill(settings.url!, message, encodeURIComponent), {
        method: get ? 'GET' : 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`The SMS endpoint answered ${response.status}: ${await reason(response)}`)
      }
    },
  }
}
