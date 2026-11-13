# OTP for OTW CMS

Two-step sign-in, and one-time codes for any form on the site. After a correct password, people
who have set it up are asked for a code: from an authenticator app, by email, or by text message
through Twilio or any SMS service of your own.

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

or from the admin, **Plugins › Add Plugin**. It needs OTW CMS 1.7 or later. Activate **OTP** on
the Plugins screen. Codes by email need a mail plugin, such as
[Mailer](https://github.com/OTWSRL/otw-mailer).

Nothing changes for anyone until they set a way up, on their **Profile** in the admin or on
their account page on the site, or until you name roles that must use a code.

## Ways to get a code

| Way               | How it's set up                                     | Needs                  |
| ----------------- | --------------------------------------------------- | ---------------------- |
| Authenticator app | Scan a QR code, then type the app's code            | Nothing                |
| Email             | Type a code sent to the account's address           | A mail plugin          |
| Text message      | Give a mobile number, then type a code texted to it | An SMS provider, below |
| Backup codes      | Ten come with the first way; each signs in once     | One of the ways above  |

An app's codes follow RFC 6238 (SHA-1, six digits, thirty seconds), which Google Authenticator,
1Password, Authy, Microsoft Authenticator and the rest all read. A code works once, and for one
step either side of the server's clock.

Sent codes are six digits, work for ten minutes (a setting) and for five tries, and only the
newest one works. An address gets one a minute and five an hour.

## Settings

**OTP › Settings**, for those with the `otp.manage` capability (administrators, until a role is
granted it).

| Setting                                | What it does                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Roles that must use a code             | Role ids, such as `administrator, editor`. Their people get codes by email until they set up their own way |
| Remember a browser                     | Offers "Don't ask again on this device" for 7, 30 or 90 days. Off by default                               |
| Authenticator app, Email, Text message | Which ways people may set up. Text message is off until you turn it on                                     |
| A sent code works for                  | 5, 10 or 15 minutes                                                                                        |
| Send text messages through             | Automatic, Twilio, or an HTTP request                                                                      |
| Codes forms may send an hour           | A ceiling on what the site's own forms send visitors, per channel. 100 by default                          |

## Text messages

### Twilio

Set these in the server's environment, then turn **Text message** on in Settings:

```sh
TWILIO_ACCOUNT_SID=AC…
TWILIO_AUTH_TOKEN=…
TWILIO_FROM=+14155552671   # a Twilio number, a sender name, or a Messaging Service SID (MG…)
```

`TWILIO_ACCOUNT_SID` and `TWILIO_FROM` can also be typed in Settings; the token comes from the
environment only. To sign in with an API key instead of the account's token, which can be
revoked on its own, set `TWILIO_API_KEY` (SK…) and `TWILIO_API_SECRET` as well.

**OTP › Status** has **Send a test message**, and says which provider texts go through.

### Any other service, over HTTP

Set `OTP_SMS_URL` (or **HTTP request URL** in Settings) to an endpoint of yours or of an SMS
gateway. Each message is a `POST`:

```http
POST /your/endpoint
Content-Type: application/json
Authorization: Bearer <OTP_SMS_TOKEN, when set>

{ "to": "+393331234567", "text": "123456 is your My Site code. It works for 10 minutes." }
```

Any 2xx answer counts as sent.

### A provider in code

For a service with an API of its own, add a provider from a plugin. On **Automatic**, a provider
a plugin added is used before Twilio and the HTTP request.

```ts
import { definePlugin } from '@otwdesign/sdk'
import type {} from '@otwdesign/plugin-otp'

export default definePlugin({
  id: 'my-sms',
  version: '1.0.0',
  requires: { otp: '^1.0.0' },
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

A whole new channel, such as WhatsApp, is added the same way to the `otp.channels` registry:
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
  requires: { otp: '^1.0.0' },
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
- **App secrets are encrypted** (AES-256-GCM) once `OTP_SECRET_KEY` is set, to 32 or more random
  characters, in the server's environment. Without it they're stored as they are, and
  **OTP › Status** says so. Keep the key: secrets sealed with it can't be read without it.
- **Removing a way asks for the password**, and every change to someone's two-step sign-in is
  emailed to them.
- **A password reset doesn't bypass it.** After setting a password from an emailed link, a
  person with an app or a phone is still asked for its code. One whose only way is email is not:
  the link has just proved the same inbox.
- **A form's codes are limited** per address and, for the whole site, per hour, so a form can't
  be used to flood an inbox or run up the SMS bill.

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
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio's account                                               |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET`     | A Twilio API key, instead of the Auth Token                    |
| `TWILIO_FROM`                             | The number, sender name or Messaging Service texts come from   |
| `OTP_SMS_URL`, `OTP_SMS_TOKEN`            | The HTTP provider's endpoint, and its bearer token             |

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
