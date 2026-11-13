'use client'

import { useEffect, useId, useRef, useState } from 'react'

/** What `<OtpField>` takes. */
export interface OtpFieldProps {
  /** The purpose the form's plugin declared with `otp.purpose()`, such as `contact`. */
  purpose: string
  /** How the code is sent: `email` (the default) or `sms`. */
  channel?: string
  /** The `name` of the form's own input that holds the address or number to check. */
  source: string
  /** The `name` of the hidden input the form gets once the code passes. Defaults to `otp`. */
  name?: string
  /** The words on the button that sends the code. */
  sendLabel?: string
  /** Where codes are asked for and checked, when the site moved its API. */
  endpoints?: { send: string; check: string }
}

// Layout only: the form's own styles decide how inputs and buttons look.
const STYLES = `
.otp-field-check { display: grid; gap: 0.5rem; margin: 0 0 0.75rem; }
.otp-field-code { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.otp-field-code input { width: 9em; padding: 0.4rem 0.5rem; font: inherit; }
.otp-field-status { margin: 0; min-height: 1.5em; }
`

type Step =
  | { at: 'idle' }
  | { at: 'sent'; id: string; to: string; address: string }
  | { at: 'verified'; id: string; to: string; address: string }

const ENDPOINTS = { send: '/api/p/otp/send', check: '/api/p/otp/check' }

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

/**
 * Checks an email address or phone number inside any form: a button sends a code to what the
 * form's `source` input holds, the visitor types it, and once it passes the form carries a
 * hidden input, `otp` by default, that the form's handler gives to `otp.consume()`. Changing
 * the address afterwards asks for a new code.
 */
export function OtpField({
  purpose,
  channel = 'email',
  source,
  name = 'otp',
  sendLabel = 'Send me a code',
  endpoints = ENDPOINTS,
}: OtpFieldProps) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<Step>({ at: 'idle' })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)

  /** What the form's own input holds now. */
  const address = (): string => {
    const input = root.current?.closest('form')?.elements.namedItem(source)
    return input instanceof HTMLInputElement ? input.value.trim() : ''
  }
  // A code proves the address it was sent to: once that input changes, it proves nothing.
  const proved = useRef<string | null>(null)
  useEffect(() => {
    const form = root.current?.closest('form')
    if (!form) return
    const changed = (event: Event) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement) || input.name !== source) return
      if (proved.current === null || proved.current === input.value.trim()) return
      proved.current = null
      setStep({ at: 'idle' })
      setMessage(null)
    }
    form.addEventListener('input', changed)
    return () => form.removeEventListener('input', changed)
  }, [source])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch {
      setMessage({ error: true, text: 'Something went wrong. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const send = () =>
    run(async () => {
      const to = address()
      if (!to) {
        setMessage({ error: true, text: 'Fill in where the code should go first.' })
        return
      }
      const sent = await post(endpoints.send, { purpose, channel, to })
      if (typeof sent.id !== 'string') {
        const text = typeof sent.error === 'string' ? sent.error : 'The code couldn’t be sent.'
        setMessage({ error: true, text })
        return
      }
      setCode('')
      proved.current = to
      setStep({ at: 'sent', id: sent.id, to: String(sent.to ?? to), address: to })
      setMessage({ error: false, text: `We sent a code to ${String(sent.to ?? to)}.` })
    })

  const check = () =>
    run(async () => {
      if (step.at !== 'sent') return
      const { verified } = await post(endpoints.check, { id: step.id, code })
      if (verified === true) {
        setStep({ ...step, at: 'verified' })
        setMessage({ error: false, text: `${step.to} is confirmed.` })
      } else {
        setMessage({ error: true, text: 'That code isn’t right, or it has run out.' })
      }
    })

  return (
    <div className="otp-field-check" ref={root}>
      <style href="otw-otp-field" precedence="default">
        {STYLES}
      </style>
      {step.at === 'verified' && <input type="hidden" name={name} value={step.id} />}
      {step.at === 'sent' && (
        <div className="otp-field-code">
          <label htmlFor={`${id}-code`}>Code</label>
          <input
            id={`${id}-code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              // Enter checks the code; it mustn't send the whole form yet.
              if (event.key !== 'Enter') return
              event.preventDefault()
              void check()
            }}
          />
          <button type="button" onClick={() => void check()} disabled={busy || code.trim() === ''}>
            Check code
          </button>
        </div>
      )}
      {step.at !== 'verified' && (
        <div>
          <button type="button" onClick={() => void send()} disabled={busy}>
            {step.at === 'sent' ? 'Send a new code' : sendLabel}
          </button>
        </div>
      )}
      <p className="otp-field-status" role={message?.error ? 'alert' : 'status'} aria-live="polite">
        {message?.text ?? ''}
      </p>
    </div>
  )
}
