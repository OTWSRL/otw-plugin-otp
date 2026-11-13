# OTP for OTW CMS

Two-step sign-in, and one-time codes for any form on the site. After a correct password, people
who have set it up are asked for a code: from an authenticator app, by email, by text message
through Twilio or any SMS service of your own, or over WhatsApp.

- **Signing in**: the admin's sign-in and the site's account page both ask for the code, and a
  password set from an emailed link still does.
- **For each person**: an app (with a QR code), email, a phone number, ten backup codes, and
  "Don't ask again on this device".
- **For the site**: roles that must use a code, which ways are allowed, and a reset for someone
  who is locked out.
- **For any form**: `<OtpField>` checks an email address or phone number with a code before
  the form is taken.

## Install

```sh
npx cms plugin add @otwdesign/plugin-otp
```

or from the admin, **Plugins › Add Plugin**. It needs OTW CMS 1.8 or later. Activate **OTP** on
the Plugins screen. Codes by email need a mail plugin, such as
[Mailer](https://github.com/OTWSRL/otw-mailer).

Nothing changes for anyone until they set a way up, on their **Profile** in the admin or on
their account page on the site, or until you name roles that must use a code.

## Ways to get a code

| Way               | How it's set up                                         | Needs                      |
| ----------------- | ------------------------------------------------------- | -------------------------- |
| Authenticator app | Scan a QR code, then type the app's code                | Nothing                    |
| Email             | Type a code sent to the account's address               | A mail plugin              |
| Text message      | Give a mobile number, then type a code texted to it     | An SMS provider, below     |
| WhatsApp          | Give a mobile number, then type a code sent on WhatsApp | A WhatsApp provider, below |
| Backup codes      | Ten come with the first way; each signs in once         | One of the ways above      |

An app's codes follow RFC 6238 (SHA-1, six digits, thirty seconds), which Google Authenticator,
1Password, Authy, Microsoft Authenticator and the rest all read. A code works once, and for one
step either side of the server's clock.

Sent codes are six digits, work for ten minutes (a setting) and for five tries, and only the
newest one works. An address gets one a minute and five an hour.

## Settings

**OTP › Settings**, for those with the `otp.manage` capability (administrators, until a role is
granted it). The page shows only what applies: a channel's section once that channel is ticked,
and a provider's fields once that provider is chosen.

| Setting                      | What it does                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Roles that must use a code   | A checkbox for each of the site's roles. Their people get codes by email until they set up a way |
| Remember a browser           | Offers "Don't ask again on this device" for 7, 30 or 90 days. Off by default                     |
| Authenticator app, Email     | Which ways people may set up. Both on                                                            |
| Text message, WhatsApp       | Off until you tick them; each then shows its own section                                         |
| A sent code works for        | 5, 10 or 15 minutes                                                                              |
| Codes forms may send an hour | A ceiling on what forms, and people setting up a way, are sent in an hour, per channel. 100      |

## Text messages

Tick **Text message**, then choose under **Send text messages through**. **OTP › Status** has a
test for each, and says which provider texts go through.

### Twilio

Set these in the server's environment:

```sh
TWILIO_ACCOUNT_SID=AC…
TWILIO_AUTH_TOKEN=…
TWILIO_FROM=+14155552671   # a Twilio number, a sender name, or a Messaging Service SID (MG…)
```

The Account SID and the sender can also be typed in Settings; the token comes from the
environment only. To sign in with an API key instead of the account's token, which can be
revoked on its own, set `TWILIO_API_KEY` (SK…) and `TWILIO_API_SECRET` as well.

### Any other service, over an HTTP request

Choose **An HTTP request** and give the request's URL (or `OTP_SMS_URL`). As it comes, each
message is a `POST` of this JSON, with `Authorization: Bearer <OTP_SMS_TOKEN>` when that's set:

```json
{ "to": "+393331234567", "text": "123456 is your My Site code. It works for 10 minutes." }
```

Any 2xx answer counts as sent. Most services want their own shape, so every part can change:

| Setting       | Choices                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| Request URL   | May hold `{{to}}` and `{{text}}`, for a service that takes everything in the address  |
| Method        | `POST`, or `GET` with no body                                                         |
| Authorization | A bearer token, custom headers, or none                                               |
| Headers       | Rows of a header and its value, as many as the service needs                          |
| Body          | The JSON above, a form (`to=…&text=…`), or a template of your own                     |
| Body template | Your service's body, with `{{to}}` and `{{text}}` where the number and the message go |
| Content type  | The template's: `application/json`, `application/x-www-form-urlencoded`, `text/xml`   |

For example, a service that wants a key in a header and its own JSON:

```
Authorization   Custom headers
Headers         X-Api-Key   env:SMS_API_KEY
Body            Your own template
Body template   { "recipients": ["{{to}}"], "message": { "body": "{{text}}" } }
```

- **A header's value written `env:NAME`** is read from the server's environment, so a key
  isn't kept in the database. A value typed as it is, is stored there and shown to whoever
  manages OTP.
- **Placeholders are escaped for the content type**: as a JSON string, a form value or XML text,
  so no message can break out of the body. In the URL they're percent-encoded.
- **Header names and values are checked**: no line breaks, and not `Host`, `Content-Length`,
  `Transfer-Encoding` or `Connection`, which the request sets itself.

### A provider in code

For a service with an API of its own, add a provider from a plugin, and choose **A provider
another plugin adds**:

```ts
import { definePlugin } from '@otwdesign/sdk'
import type {} from '@otwdesign/plugin-otp'

export default definePlugin({
  id: 'my-sms',
  version: '1.0.0',
  requires: { otp: '^1.1.0' },
  setup(cms) {
    cms.registries.get('otp.sms').add({
      id: 'my-sms',
      label: 'My SMS service',
      ready: () => Boolean(process.env.MY_SMS_KEY),
      async send({ to, text }) {
        const response = await fetch('https://sms.example.com/v1/messages', {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env.MY_SMS_KEY}` },
          body: JSON.stringify({ to, text }),
        })
        // Throwing tells OTP it wasn't sent; the reason goes to the server's log.
        if (!response.ok) throw new Error(`My SMS service answered ${response.status}`)
      },
    })
  },
})
```

## WhatsApp

WhatsApp lets a business start a conversation only with a **message template** it has had
approved. So before turning this on, make a template of the **authentication** kind with your
provider: its text is WhatsApp's own ("123456 is your verification code"), with a **Copy code**
button. Then tick **WhatsApp** in Settings and choose the provider.

### WhatsApp Cloud API (Meta)

| Setting           | Where it comes from                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Phone number ID   | Your WhatsApp Business number's ID in Meta's dashboard, or `WHATSAPP_PHONE_ID`               |
| Access token      | `WHATSAPP_TOKEN`, environment only: a system user's token with `whatsapp_business_messaging` |
| Template name     | The approved authentication template, such as `sign_in_code`                                 |
| Template language | The template's language. `en_US` unless you say                                              |

### Twilio

It uses the same Twilio account as text messages, with:

| Setting              | What it is                                                                         |
| -------------------- | ---------------------------------------------------------------------------------- |
| WhatsApp sender      | Your WhatsApp number at Twilio, or a Messaging Service SID. `TWILIO_WHATSAPP_FROM` |
| Content template SID | The approved authentication template (`HX…`), whose variable `{{1}}` is the code   |

### A provider in code

Add one to the `otp.whatsapp` registry, as for SMS. It's handed the code, not a text, since the
template words the message: `send({ to, code })`.

A whole new channel, such as a voice call, is added the same way to the `otp.channels` registry:
people can then set it up and sign in with it like the plugin's own.

## Codes for any form

`<OtpField>` goes inside a form of yours. It sends a code to what the form's own input holds,
checks what the visitor types, and then gives the form a hidden `otp` input that the form's
handler hands to `otp.consume()`.

```tsx
import { OtpField } from '@otwdesign/plugin-otp/field'
import { definePlugin } from '@otwdesign/sdk'
import type {} from '@otwdesign/plugin-otp'

export default definePlugin({
  id: 'contact',
  version: '1.0.0',
  requires: { otp: '^1.1.0' },
  setup(cms) {
    const otp = cms.services.get('otp')
    // Only declared purposes can be asked for from the browser.
    otp.purpose('contact')

    cms.routes.api({
      method: 'POST',
      path: '/send',
      handler: async (request) => {
        const form = await request.formData()
        const email = String(form.get('email') ?? '')
        // True once, and only for the address the code went to.
        const proved = await otp.consume(String(form.get('otp') ?? ''), {
          to: email,
          purpose: 'contact',
        })
        if (!proved) return new Response('Confirm your email address first', { status: 400 })
        // … take the message
        return new Response('Sent')
      },
    })

    cms.routes.page({
      name: 'form',
      path: '/contact',
      component: () => (
        <form method="post" action={cms.routes.apiUrl('/send')}>
          <label>
            Email address <input name="email" type="email" required />
          </label>
          <OtpField purpose="contact" source="email" />
          <button type="submit">Send</button>
        </form>
      ),
    })
  },
})
```

A purpose allows email unless it says otherwise:
`otp.purpose('callback', { channels: ['email', 'sms'] })`, with `<OtpField channel="sms" …>`.
Text messages cost money, so they're never allowed by default.

From server code, the same service sends and checks without the field:

| Call                                 | What it does                                                       |
| ------------------------------------ | ------------------------------------------------------------------ |
| `otp.send({ channel, to, purpose })` | Sends a code; returns its `id`, the masked address, and its expiry |
| `otp.check(id, code)`                | Whether the code is right. Five wrong ones end it                  |
| `otp.consume(id, { to, purpose })`   | Whether it was checked for that address and purpose; true once     |
| `otp.channels()`                     | The channels, and whether each can send now                        |
| `otp.status(userId)`                 | The ways a person signs in with, and their unused backup codes     |

## Security

- **Core counts wrong codes** at sign-in: five in fifteen minutes, over all of an account's
  sign-ins, end it. A held sign-in lasts ten minutes.
- **An app's code works once.** The step it was used for is remembered.
- **Codes are kept only as hashes**: sent codes, backup codes, and remembered browsers.
- **Provider secrets stay out of the database.** Twilio's and WhatsApp's tokens are read from
  the environment only, and a custom header can be too (`env:NAME`). No header value, and no
  request's filled-in address, is written to the log.
- **App secrets are encrypted** (AES-256-GCM) once `OTP_SECRET_KEY` is set, to 32 or more random
  characters, in the server's environment. Without it they're stored as they are, and
  **OTP › Status** says so. Keep the key: secrets sealed with it can't be read without it.
- **Removing a way asks for the password**, and every change to someone's two-step sign-in is
  emailed to them.
- **A password reset doesn't bypass it.** After setting a password from an emailed link, a
  person with an app or a phone is still asked for its code. One whose only way is email is not:
  the link has just proved the same inbox.
- **What can be sent is limited**: one code a minute and five an hour to an address, ten an hour
  to a person, and for the whole site an hourly ceiling on codes for forms and for setting a way
  up. So neither a form nor an account can be used to flood an inbox or run up the SMS bill.

## Locked out

- **One person**: an administrator opens **Users**, that person's **Edit User** screen, and
  clicks **Reset Two-Step Sign-In**. They then sign in with their password alone, and are told
  by email.
- **Everyone**: set `OTP_DISABLED=true` in the server's environment and restart it. Nobody is
  asked for a code until it's removed; **OTP › Status** shows a warning while it's set.

## Environment variables

| Variable                                  | What it's for                                                  |
| ----------------------------------------- | -------------------------------------------------------------- |
| `OTP_SECRET_KEY`                          | Encrypts app secrets. 32 or more random characters             |
| `OTP_DISABLED`                            | `true` asks nobody for a code: for an administrator locked out |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio's account, for text messages and WhatsApp alike         |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET`     | A Twilio API key, instead of the Auth Token                    |
| `TWILIO_FROM`                             | The number, sender name or Messaging Service texts come from   |
| `TWILIO_WHATSAPP_FROM`                    | The WhatsApp sender at Twilio                                  |
| `OTP_SMS_URL`, `OTP_SMS_TOKEN`            | The HTTP request's URL, and its bearer token                   |
| `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`     | The Cloud API's phone number ID and access token               |
| `WHATSAPP_API_VERSION`                    | The Graph API version requests name. `v27.0` unless you say    |

`TWILIO_API_URL` and `WHATSAPP_API_URL` point the two services' requests at another address,
for a test server or a proxy.

## A site with its own account template

The code's screen on the site is the account template's `verify` view, new in OTW CMS 1.7. A
site that replaced the account template (`src/cms/templates.tsx`) shows it once that template
handles `view === 'verify'`: `props.signIn` has the way being asked for and the others, and
`actions.verify` and `actions.sendCode` are where its forms post. The default template is the
example.

## Deleting its data

**Plugins › Delete Data**, while the plugin is inactive, drops its four tables (`otp_methods`,
`otp_backup_codes`, `otp_challenges`, `otp_devices`) and its settings.

## Developing

The repo's root is the plugin; `site/` is an OTW site it's tested on, with a stand-in SMS
service. The CMS is linked from a checkout beside this repo (`../nextjs-cms`).

```sh
pnpm install
pnpm dev          # the test site, on http://localhost:3000
pnpm test:all     # lint, format, types, unit tests, then the browser tests
```

## License

Apache-2.0
