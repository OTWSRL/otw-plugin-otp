// Where codes go: email addresses and phone numbers, as they're kept, compared and shown.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** An email address, lowercase, or `null` when it isn't one. */
export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase()
  return EMAIL.test(email) && email.length <= 254 ? email : null
}

/**
 * A phone number in E.164, `+393331234567`, or `null`: it must start with `+` and its country
 * code, since a code texted to the wrong country reaches a stranger. Spaces, dashes, dots and
 * brackets are dropped, and `00` at the start reads as `+`.
 */
export function normalizePhone(value: string): string | null {
  const digits = value
    .trim()
    .replace(/^00/, '+')
    .replace(/[\s().-]/g, '')
  return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : null
}

/** `a•••@example.com`: enough to recognise an address, not to learn it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 1 ? '•••' : `${email[0]}•••${email.slice(at)}`
}

/** `the number ending in 67`. */
export function maskPhone(phone: string): string {
  return `the number ending in ${phone.slice(-2)}`
}
