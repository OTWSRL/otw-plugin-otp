import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'

// What the plugin keeps secret: an app's secret, encrypted when the site has a key, and codes,
// kept only as hashes.

/** The environment variable that holds the site's key: any long random string. */
export const KEY_ENV = 'OTP_SECRET_KEY'
const MIN_KEY_LENGTH = 32
const SEALED = 'v1.'
const PLAIN = 'plain.'
/** Letters and digits that aren't mistaken for one another when read off paper. */
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const BACKUP_LENGTH = 10

export interface Keys {
  /** Whether the site has a key, so app secrets are encrypted. */
  readonly encrypted: boolean
  /** An app's secret as it's stored. */
  seal(secret: string): string
  /** A stored secret, or `null` when it was sealed with a key the site no longer has. */
  open(stored: string): string | null
  /** A code's hash under `salt`, the id of what it belongs to. */
  hash(salt: string, code: string): string
}

/** Why a key can't be used, or `null`. */
export function keyProblem(value: string | undefined): string | null {
  if (!value) return null
  return value.length < MIN_KEY_LENGTH
    ? `${KEY_ENV} needs at least ${MIN_KEY_LENGTH} characters`
    : null
}

/**
 * The site's keys, from `OTP_SECRET_KEY`. Without one, secrets are stored as they are and codes
 * are hashed without a key: a copy of the database then holds what an app needs to make codes.
 */
export function createKeys(value: string | undefined): Keys {
  const usable = value && keyProblem(value) === null ? value : null
  // Derived when first needed: a site that never asks for a code never pays for it.
  let derived: { seal: Buffer; hash: Buffer } | null = null
  const keys = () => {
    if (!usable) return null
    derived ??= {
      seal: Buffer.from(hkdfSync('sha256', usable, 'otw-plugin-otp', 'app-secrets', 32)),
      hash: Buffer.from(hkdfSync('sha256', usable, 'otw-plugin-otp', 'code-hashes', 32)),
    }
    return derived
  }
  return {
    encrypted: usable !== null,
    seal(secret) {
      const key = keys()
      if (!key) return PLAIN + secret
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key.seal, iv)
      const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
      return SEALED + Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')
    },
    open(stored) {
      if (stored.startsWith(PLAIN)) return stored.slice(PLAIN.length)
      const key = keys()
      if (!key || !stored.startsWith(SEALED)) return null
      const bytes = Buffer.from(stored.slice(SEALED.length), 'base64url')
      if (bytes.length < 29) return null
      try {
        const decipher = createDecipheriv('aes-256-gcm', key.seal, bytes.subarray(0, 12))
        decipher.setAuthTag(bytes.subarray(12, 28))
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
          'utf8',
        )
      } catch {
        // Sealed with another key, or changed since.
        return null
      }
    },
    hash(salt, code) {
      return createHmac('sha256', keys()?.hash ?? 'otw-plugin-otp')
        .update(`${salt}:${code}`)
        .digest('hex')
    },
  }
}

/** Whether two hashes are the same, in the same time whichever they are. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** A code to send: six digits, each equally likely. */
export function numericCode(digits = 6): string {
  return String(randomInt(10 ** digits)).padStart(digits, '0')
}

/** A backup code, `abcde-fghjk`: fifty bits, in letters that read clearly. */
export function backupCode(): string {
  let code = ''
  for (let index = 0; index < BACKUP_LENGTH; index++) {
    code += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

/** A backup code as typed, without its dash, spaces or capitals; `null` when it can't be one. */
export function cleanBackupCode(typed: string): string | null {
  const code = typed.replace(/[\s-]/g, '').toLowerCase()
  return code.length === BACKUP_LENGTH && [...code].every((char) => BACKUP_ALPHABET.includes(char))
    ? code
    : null
}
