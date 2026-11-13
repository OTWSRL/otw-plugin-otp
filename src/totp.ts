import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// An authenticator app's codes: TOTP (RFC 6238) over HOTP (RFC 4226), with the settings every
// app understands: SHA-1, six digits, thirty seconds.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** Seconds a code lasts. */
export const PERIOD = 30
export const DIGITS = 6
/** Steps either side of now a code is accepted for: a phone's clock is rarely exact. */
const WINDOW = 1

/** Bytes as base32 (RFC 4648), without padding: how authenticator apps take a secret. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let text = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      text += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) text += ALPHABET[(value << (5 - bits)) & 31]
  return text
}

/** Base32 as bytes; spaces, case and padding don't matter. `null` for anything else. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  if (clean === '' || /[^A-Z2-7]/.test(clean)) return null
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** A new secret for an app: 160 bits, as RFC 4226 recommends, in base32. */
export function newSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The code for one counter value (RFC 4226). */
export function hotp(secret: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = digest[digest.length - 1]! & 15
  const number = digest.readUInt32BE(offset) & 0x7fffffff
  return String(number % 10 ** DIGITS).padStart(DIGITS, '0')
}

/** Which thirty-second step a moment, in milliseconds since 1970, falls in. */
export function stepAt(at: number): number {
  return Math.floor(at / 1000 / PERIOD)
}

/** The code an app shows for `secret` at a moment. */
export function totp(secret: string, at: number): string {
  const key = base32Decode(secret)
  if (!key) throw new TypeError('The secret is not base32')
  return hotp(key, stepAt(at))
}

/**
 * The step `code` is right for, now or one step either side, or `null`. A step at or before
 * `after`, the last one this secret was used for, doesn't count: a code works once.
 */
export function matchTotp(
  secret: string,
  code: string,
  at: number,
  after: number | null = null,
): number | null {
  const key = base32Decode(secret)
  if (!key || !/^\d{6}$/.test(code)) return null
  const typed = Buffer.from(code)
  const now = stepAt(at)
  let matched: number | null = null
  // Every candidate is compared, so how long it takes says nothing about which one matched.
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    const right = timingSafeEqual(typed, Buffer.from(hotp(key, step)))
    if (right && (after === null || step > after) && matched === null) matched = step
  }
  return matched
}

/** What the QR code holds: the secret, and the names the app shows beside its codes. */
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  // A colon separates issuer from account in the label, so neither may hold one.
  const issuer = input.issuer.replace(/:/g, ' ').trim() || 'Website'
  const account = input.account.replace(/:/g, ' ').trim()
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const query = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  })
  return `otpauth://totp/${label}?${query.toString().replace(/\+/g, '%20')}`
}

/** A secret in groups of four, for typing into an app that can't scan. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ')
}
