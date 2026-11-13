import type { ReactNode } from 'react'
import type { Overview, WayView } from './engine'
import { QrCode } from './qr'

/** Where the section shows: the admin's Profile, with WordPress's form classes, or the site. */
type Look = 'admin' | 'site'

interface Shared {
  /** Where one of the plugin's forms posts, by action name. */
  action(name: string): string
  look: Look
}

const classes = (look: Look) =>
  look === 'admin'
    ? {
        button: 'button',
        primary: 'button button-primary',
        input: 'regular-text',
        hint: 'description',
      }
    : // The account pages' own classes, so a site's theme styles these fields as it does theirs.
      { button: undefined, primary: undefined, input: undefined, hint: 'account-hint' }

/** One of the section's forms. Plain HTML: it works before any JavaScript does. */
function Form({
  to,
  label,
  fields = {},
  submit,
  primary = false,
  look,
  children,
}: {
  to: string
  label: string
  fields?: Record<string, string>
  submit: string
  primary?: boolean
  look: Look
  children?: ReactNode
}) {
  const ui = classes(look)
  return (
    <form method="post" action={to} aria-label={label} className="otp-form">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <button type="submit" className={primary ? ui.primary : ui.button}>
        {submit}
      </button>
    </form>
  )
}

/** A labelled input, with ids of its own however many of the section's forms have one. */
function Field({
  id,
  name,
  label,
  look,
  hint,
  ...input
}: {
  id: string
  name: string
  label: string
  look: Look
  hint?: string
  type?: 'text' | 'tel' | 'password'
  inputMode?: 'numeric' | 'tel'
  autoComplete: string
  maxLength?: number
  placeholder?: string
}) {
  const ui = classes(look)
  return (
    <div className={look === 'site' ? 'otp-field account-field' : 'otp-field'}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        className={ui.input}
        aria-describedby={hint ? `${id}-hint` : undefined}
        required
        {...input}
      />
      {hint && (
        <span className={ui.hint} id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  )
}

const CODE = { inputMode: 'numeric', autoComplete: 'one-time-code', maxLength: 12 } as const

/** Removing a way asks for the password again: a session left open mustn't be enough. */
function Remove({ way, action, look }: Shared & { way: WayView }) {
  return (
    <details className="otp-remove">
      <summary>Remove</summary>
      <Form
        to={action('remove-way')}
        label={`Remove ${way.label}`}
        fields={{ method: way.id }}
        submit={`Remove ${way.label}`}
        look={look}
      >
        <Field
          id={`otp-remove-${way.id}`}
          name="password"
          label="Your password"
          type="password"
          autoComplete="current-password"
          look={look}
        />
      </Form>
    </details>
  )
}

function AppWay({ way, action, look }: Shared & { way: WayView }) {
  if (way.state === 'on') {
    return (
      <>
        <p>On: you’re asked for a code from your app when you sign in.</p>
        <Remove way={way} action={action} look={look} />
      </>
    )
  }
  if (way.state === 'pending' && way.uri && way.secret) {
    return (
      <>
        <ol className="otp-steps">
          <li>
            Open your authenticator app (Google Authenticator, 1Password, Authy or another) and scan
            this code.
            <div className="otp-qr-frame">
              <QrCode text={way.uri} label="QR code for your authenticator app" />
            </div>
            Can’t scan it? Enter this key in the app instead: <code>{way.secret}</code>
          </li>
          <li>Enter the 6-digit code the app shows, to check it’s set up right.</li>
        </ol>
        <Form
          to={action('confirm-app')}
          label="Confirm your app"
          submit="Turn on"
          primary
          look={look}
        >
          <Field id="otp-app-code" name="code" label="Code from the app" look={look} {...CODE} />
        </Form>
        <Form
          to={action('cancel-setup')}
          label="Cancel setting up your app"
          fields={{ method: way.id }}
          submit="Cancel"
          look={look}
        />
      </>
    )
  }
  return (
    <>
      <p>Codes from an app on your phone. They work without a signal, and can’t be intercepted.</p>
      <Form
        to={action('start-app')}
        label="Set up an authenticator app"
        submit="Set up an app"
        look={look}
      />
    </>
  )
}

function ChannelWay({ way, action, look }: Shared & { way: WayView }) {
  const phone = way.kind === 'phone'
  if (way.state === 'on') {
    return (
      <>
        <p>On: codes go to {way.to}.</p>
        <Remove way={way} action={action} look={look} />
      </>
    )
  }
  if (way.state === 'pending') {
    return (
      <>
        <p>We sent a code to {way.to}. Enter it to turn this on.</p>
        <Form
          to={action('confirm-channel')}
          label={`Confirm ${way.label}`}
          fields={{ channel: way.id }}
          submit="Turn on"
          primary
          look={look}
        >
          <Field id={`otp-${way.id}-code`} name="code" label="Code" look={look} {...CODE} />
        </Form>
        <Form
          to={action('start-channel')}
          label={`Send a new code by ${way.label}`}
          fields={{ channel: way.id }}
          submit="Send a new code"
          look={look}
        />
        <Form
          to={action('cancel-setup')}
          label={`Cancel setting up ${way.label}`}
          fields={{ method: way.id }}
          submit="Cancel"
          look={look}
        />
      </>
    )
  }
  return (
    <Form
      to={action('start-channel')}
      label={`Set up ${way.label}`}
      fields={{ channel: way.id }}
      submit={phone ? 'Send a code' : `Send a code to ${way.to}`}
      look={look}
    >
      {phone && (
        <Field
          id={`otp-${way.id}-to`}
          name="to"
          label="Mobile number"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={24}
          placeholder="+39 333 123 4567"
          hint="With its country code. We’ll text it a code to check it’s yours."
          look={look}
        />
      )}
    </Form>
  )
}

// Layout only: colours and type come from the page the section is on.
const STYLES = `
.otp-two-step .otp-way { margin: 1.25em 0; }
.otp-two-step .otp-form { display: flex; flex-wrap: wrap; align-items: end; gap: 0.5em 0.75em; margin: 0.5em 0; }
.otp-two-step .otp-field { display: grid; gap: 0.25em; }
.otp-two-step .otp-field input { max-width: 100%; }
.otp-two-step .otp-steps { padding-left: 1.25em; }
.otp-two-step .otp-steps li { margin: 0 0 0.75em; }
.otp-two-step .otp-qr-frame { margin: 0.75em 0; }
.otp-two-step .otp-qr { display: block; max-width: 100%; height: auto; }
.otp-two-step .otp-fresh { margin: 1em 0; padding: 0.25em 1em 1em; border: 1px solid currentColor; border-radius: 4px; }
.otp-two-step .otp-codes { display: grid; grid-template-columns: repeat(auto-fill, minmax(9em, 1fr)); gap: 0.4em 1em; margin: 0.75em 0; padding: 0; list-style: none; }
.otp-two-step .otp-codes code { font-size: 1.05em; }
.otp-two-step .otp-remove summary { cursor: pointer; width: fit-content; }
`

function status(overview: Overview): string {
  if (overview.fallback) {
    return 'Your role must sign in with a code. Until you set up a way of your own, codes are emailed to you.'
  }
  if (overview.on) return 'On: after your password, you’re asked for a code.'
  return overview.required
    ? 'Your role must sign in with a code. Set up a way to get one.'
    : 'Off: you sign in with your password alone. Set up a way to get a code, so a stolen password isn’t enough.'
}

/**
 * A person's two-step sign-in: each way to get a code, with what it takes to turn it on or
 * off, their backup codes, and the browsers that don't ask. A server component with plain forms,
 * on the admin's Profile and on the site's account page alike.
 */
export function TwoStepSection({ overview, action, look }: Shared & { overview: Overview }) {
  // A way turned off in Settings shows only to someone who has it, to remove.
  const ways = overview.ways.filter((way) => way.state !== 'unavailable')
  const hasWay = overview.ways.some((way) => way.state === 'on')
  const { left, total } = overview.backups
  return (
    <section className="otp-two-step" id="two-step" aria-labelledby="two-step-title">
      <style href="otw-otp" precedence="default">
        {STYLES}
      </style>
      <h2 id="two-step-title">Two-step sign-in</h2>
      <p>{status(overview)}</p>

      {overview.fresh && (
        <div className="otp-fresh" role="group" aria-labelledby="otp-fresh-title">
          <h3 id="otp-fresh-title">Save your backup codes</h3>
          <p>
            Each signs you in once, when you can’t get a code: keep them where you keep passwords.
            They’re shown only now.
          </p>
          <ul className="otp-codes">
            {overview.fresh.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <Form
            to={action('dismiss-backup-codes')}
            label="Hide the backup codes"
            submit="I’ve saved them"
            primary
            look={look}
          />
        </div>
      )}

      {ways.map((way) => (
        <div className="otp-way" key={way.id}>
          <h3>{way.label}</h3>
          {way.kind === 'app' ? (
            <AppWay way={way} action={action} look={look} />
          ) : (
            <ChannelWay way={way} action={action} look={look} />
          )}
        </div>
      ))}
      {overview.ways
        .filter((way) => way.state === 'unavailable' && way.mine)
        .map((way) => (
          <div className="otp-way" key={way.id}>
            <h3>{way.label}</h3>
            <p>Set up, but not in use on this site right now.</p>
            <Remove way={way} action={action} look={look} />
          </div>
        ))}

      {hasWay && (
        <div className="otp-way">
          <h3>Backup codes</h3>
          <p>
            {total === 0
              ? 'You have none.'
              : `You have ${left} of ${total} left. Each signs you in once, when you can’t get a code.`}
          </p>
          <Form
            to={action('new-backup-codes')}
            label="Make new backup codes"
            submit="Make new codes"
            look={look}
          />
          {total > 0 && <p className={classes(look).hint}>New codes replace the old ones.</p>}
        </div>
      )}

      {overview.devices > 0 && (
        <div className="otp-way">
          <h3>Remembered browsers</h3>
          <p>
            {overview.devices === 1
              ? '1 browser doesn’t ask you for a code.'
              : `${overview.devices} browsers don’t ask you for a code.`}
          </p>
          <Form
            to={action('forget-devices')}
            label="Forget remembered browsers"
            submit="Forget them"
            look={look}
          />
        </div>
      )}
    </section>
  )
}
