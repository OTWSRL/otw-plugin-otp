import type { WhatsAppProvider } from './channels'
import { reason, TIMEOUT_MS, twilioAccess, twilioSend, type Fetch, type TwilioAccount } from './sms'

// The WhatsApp providers the plugin brings: Meta's own Cloud API, and Twilio. WhatsApp lets a
// business start a conversation only with a message template it has approved, so a code goes
// out as a template of the "authentication" kind, with the code as its one parameter.

const GRAPH_API = 'https://graph.facebook.com'
/** The Graph API version requests name, unless `WHATSAPP_API_VERSION` says another. */
export const GRAPH_VERSION = 'v27.0'

export interface MetaWhatsAppConfig {
  /** The WhatsApp Business phone number's ID, from Meta's dashboard: digits, not the number. */
  phoneId?: string
  /** A system user's access token. */
  token?: string
  /** The approved authentication template's name. */
  template?: string
  /** The template's language, such as `en_US`. */
  language?: string
  /** The Graph API's address and version, for tests and for pinning a version. */
  api?: string
  version?: string
}

/**
 * WhatsApp's Cloud API: `POST /{version}/{phone-number-id}/messages` with an authentication
 * template. The code is given twice, as Meta asks: for the text, and for the template's
 * "Copy code" button.
 */
export function metaWhatsAppProvider(
  config: () => MetaWhatsAppConfig,
  fetcher: Fetch = fetch,
): WhatsAppProvider {
  const ready = () => {
    const { phoneId, token, template, language } = config()
    return phoneId && token && template ? { phoneId, token, template, language } : null
  }
  return {
    id: 'meta',
    label: 'WhatsApp Cloud API',
    ready: () => ready() !== null,
    async send({ to, code }) {
      const meta = ready()
      if (!meta) throw new Error('WhatsApp’s phone number ID, token and template are not all set')
      const { api, version } = config()
      const base = (api || GRAPH_API).replace(/\/+$/, '')
      const parameters = [{ type: 'text', text: code }]
      const response = await fetcher(
        `${base}/${version || GRAPH_VERSION}/${encodeURIComponent(meta.phoneId)}/messages`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${meta.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            // The number without its plus sign, as the API's examples give it.
            to: to.replace(/^\+/, ''),
            type: 'template',
            template: {
              name: meta.template,
              language: { code: meta.language?.trim() || 'en_US' },
              components: [
                { type: 'body', parameters },
                { type: 'button', sub_type: 'url', index: '0', parameters },
              ],
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        throw new Error(`WhatsApp answered ${response.status}: ${await reason(response)}`)
      }
    },
  }
}

export interface TwilioWhatsAppConfig extends TwilioAccount {
  /** The WhatsApp sender: its number in E.164, or a Messaging Service SID, `MG…`. */
  from?: string
  /** The approved content template's SID, `HX…`. Its one variable, `{{1}}`, is the code. */
  contentSid?: string
}

/** WhatsApp through Twilio: its Messages API, with `whatsapp:` addresses and a content template. */
export function twilioWhatsAppProvider(
  config: () => TwilioWhatsAppConfig,
  fetcher: Fetch = fetch,
): WhatsAppProvider {
  const ready = () => {
    const { from, contentSid, ...account } = config()
    const access = twilioAccess(account)
    return access && from && contentSid ? { access, from, contentSid } : null
  }
  return {
    id: 'twilio',
    label: 'Twilio',
    ready: () => ready() !== null,
    async send({ to, code }) {
      const twilio = ready()
      if (!twilio) {
        throw new Error('Twilio’s account, WhatsApp sender and content template are not all set')
      }
      const service = twilio.from.startsWith('MG')
      await twilioSend(
        twilio.access,
        {
          To: `whatsapp:${to}`,
          From: service ? twilio.from : `whatsapp:${twilio.from.replace(/^whatsapp:/, '')}`,
          ContentSid: twilio.contentSid,
          ContentVariables: JSON.stringify({ 1: code }),
        },
        fetcher,
      )
    },
  }
}
