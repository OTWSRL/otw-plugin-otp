import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  groupSecret,
  hotp,
  matchTotp,
  newSecret,
  otpauthUri,
  stepAt,
  totp,
} from '../src/totp'

// RFC 6238's test secret, "12345678901234567890", as an app is given it.
const SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('base32', () => {
  it('encodes as RFC 4648 does, without padding', () => {
    const vectors: [string, string][] = [
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ]
    for (const [text, encoded] of vectors) {
      expect(base32Encode(Buffer.from(text))).toBe(encoded)
      expect(base32Decode(encoded)?.toString()).toBe(text)
    }
  })

  it('reads what a person typed: spaces, lowercase, padding', () => {
    expect(base32Decode('mzxw 6ytb oi======')?.toString()).toBe('foobar')
    expect(base32Decode('')).toBeNull()
    expect(base32Decode('MZXW1')).toBeNull()
    expect(base32Decode('not base32!')).toBeNull()
  })
})

describe('codes', () => {
  it('match RFC 4226’s HOTP values', () => {
    const key = Buffer.from('12345678901234567890')
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676']
    expect(expected.map((_, counter) => hotp(key, counter))).toEqual(expected)
  })

  it('match RFC 6238’s TOTP values, to six digits', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ]
    for (const [seconds, code] of vectors) expect(totp(SECRET, seconds * 1000)).toBe(code)
  })

  it('refuses a secret that isn’t base32', () => {
    expect(() => totp('not a secret!', 0)).toThrow('not base32')
  })
})

describe('checking a code', () => {
  const at = 1111111111 * 1000
  const step = stepAt(at)

  it('accepts this step’s code, and the ones just before and after', () => {
    expect(matchTotp(SECRET, totp(SECRET, at), at)).toBe(step)
    expect(matchTotp(SECRET, totp(SECRET, at - 30_000), at)).toBe(step - 1)
    expect(matchTotp(SECRET, totp(SECRET, at + 30_000), at)).toBe(step + 1)
    expect(matchTotp(SECRET, totp(SECRET, at - 60_000), at)).toBeNull()
    expect(matchTotp(SECRET, totp(SECRET, at + 60_000), at)).toBeNull()
  })

  it('accepts a code once: not for the step it was used for, nor an earlier one', () => {
    const code = totp(SECRET, at)
    expect(matchTotp(SECRET, code, at, step - 1)).toBe(step)
    expect(matchTotp(SECRET, code, at, step)).toBeNull()
    expect(matchTotp(SECRET, totp(SECRET, at - 30_000), at, step)).toBeNull()
    expect(matchTotp(SECRET, totp(SECRET, at + 30_000), at, step)).toBe(step + 1)
  })

  it('refuses what isn’t six digits, and a secret it can’t read', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 345', '１２３４５６']) {
      expect(matchTotp(SECRET, code, at)).toBeNull()
    }
    expect(matchTotp('!', totp(SECRET, at), at)).toBeNull()
  })
})

describe('setting up an app', () => {
  it('makes secrets of 160 bits, different each time', () => {
    const secret = newSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Decode(secret)).toHaveLength(20)
    expect(newSecret()).not.toBe(secret)
  })

  it('writes the address a QR code holds', () => {
    const uri = otpauthUri({ secret: SECRET, account: 'ada@example.com', issuer: 'My Shop: EU' })
    expect(uri).toBe(
      `otpauth://totp/My%20Shop%20%20EU:ada%40example.com?secret=${SECRET}&issuer=My%20Shop%20%20EU&algorithm=SHA1&digits=6&period=30`,
    )
    expect(otpauthUri({ secret: SECRET, account: 'a', issuer: ' ' })).toContain('totp/Website:a?')
  })

  it('groups a secret for typing', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ')
    expect(groupSecret('ABCDEFGH')).toBe('ABCD EFGH')
  })
})
