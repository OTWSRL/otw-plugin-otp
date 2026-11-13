import { OtpField } from '@otwdesign/plugin-otp/field'
import { definePlugin } from '@otwdesign/sdk'
import type {} from '@otwdesign/plugin-otp'

// The e2e tests' form: a message is taken only from an email address its sender has proved,
// with a code OTP sends. What any plugin with a form does to use OTP.

const sent: { email: string; message: string }[] = []

export default definePlugin({
  id: 'contact',
  version: '1.0.0',
  name: 'Contact',
  description: 'A contact form that checks the sender’s address with a code. For the e2e tests.',
  requires: { core: '^1.7.0', otp: '^1.0.0' },
  setup(cms) {
    const otp = cms.services.get('otp')
    // The browser may ask for codes for this, by email.
    otp.purpose('contact')

    cms.routes.api({
      method: 'POST',
      path: '/send',
      handler: async (request) => {
        const form = await request.formData()
        const text = (name: string) => String(form.get(name) ?? '')
        const page = cms.routes.url('contact.form')
        // True once, and only for the address the code went to.
        const proved = await otp.consume(text('otp'), { to: text('email'), purpose: 'contact' })
        if (!proved)
          return Response.redirect(new URL(`${page}?result=unverified`, request.url), 303)
        sent.push({ email: text('email'), message: text('message') })
        return Response.redirect(new URL(`${page}?result=sent`, request.url), 303)
      },
    })

    cms.routes.page({
      name: 'form',
      path: '/contact',
      load: ({ searchParams }) => ({
        result: String(searchParams.result ?? ''),
        count: sent.length,
      }),
      metadata: () => ({ title: 'Contact' }),
      component: ({ data }) => (
        <section className="account">
          <h1>Contact us</h1>
          {data.result === 'sent' && (
            <p className="account-notice" role="status">
              Thanks: your message was sent. We have {data.count} so far.
            </p>
          )}
          {data.result === 'unverified' && (
            <p className="account-notice account-notice-error" role="alert">
              Confirm your email address with a code first.
            </p>
          )}
          <form method="post" action={cms.routes.apiUrl('/send')} className="account-form">
            <p className="account-field">
              <label htmlFor="contact-email">Email address</label>
              <input id="contact-email" name="email" type="email" autoComplete="email" required />
            </p>
            <OtpField purpose="contact" source="email" />
            <p className="account-field">
              <label htmlFor="contact-message">Message</label>
              <input id="contact-message" name="message" required />
            </p>
            <p>
              <button type="submit">Send message</button>
            </p>
          </form>
        </section>
      ),
    })
  },
})
