import { describe, expect, it } from 'vitest'
import {
  backupCode,
  cleanBackupCode,
  createKeys,
  keyProblem,
  numericCode,
  sameHash,
} from '../src/secrets'

const KEY = 'a key of at least thirty-two characters'

describe('the site’s key', () => {
  it('encrypts an app’s secret, differently each time, and reads it back', () => {
    const keys = createKeys(KEY)
    expect(keys.encrypted).toBe(true)
    const sealed = keys.seal('JBSWY3DPEHPK3PXP')
    expect(sealed).toMatch(/^v1\.[\w-]+$/)
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP')
    expect(keys.seal('JBSWY3DPEHPK3PXP')).not.toBe(sealed)
    expect(keys.open(sealed)).toBe('JBSWY3DPEHPK3PXP')
  })

  it('can’t read what another key sealed, or what was changed', () => {
    const sealed = createKeys(KEY).seal('JBSWY3DPEHPK3PXP')
    expect(createKeys(`${KEY}!`).open(sealed)).toBeNull()
    expect(createKeys(undefined).open(sealed)).toBeNull()
    const changed = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA')
    expect(createKeys(KEY).open(changed)).toBeNull()
    expect(createKeys(KEY).open('v1.short')).toBeNull()
    expect(createKeys(KEY).open('something else')).toBeNull()
  })

  it('is optional: without it secrets are stored as they are, and still read once one is set', () => {
    const none = createKeys(undefined)
    expect(none.encrypted).toBe(false)
    expect(none.seal('JBSWY3DPEHPK3PXP')).toBe('plain.JBSWY3DPEHPK3PXP')
    expect(createKeys(KEY).open('plain.JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP')
  })

  it('must be long enough to be one', () => {
    expect(keyProblem(undefined)).toBeNull()
    expect(keyProblem(KEY)).toBeNull()
    expect(keyProblem('short')).toBe('OTP_SECRET_KEY needs at least 32 characters')
    // A key too short is not used at all, rather than used weakly.
    expect(createKeys('short').encrypted).toBe(false)
  })

  it('hashes codes under what they belong to, and under the key', () => {
    const keys = createKeys(KEY)
    expect(keys.hash('a', '123456')).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.hash('a', '123456')).toBe(keys.hash('a', '123456'))
    expect(keys.hash('b', '123456')).not.toBe(keys.hash('a', '123456'))
    expect(createKeys(undefined).hash('a', '123456')).not.toBe(keys.hash('a', '123456'))
    expect(sameHash(keys.hash('a', '1'), keys.hash('a', '1'))).toBe(true)
    expect(sameHash(keys.hash('a', '1'), keys.hash('a', '2'))).toBe(false)
    expect(sameHash('short', 'longer')).toBe(false)
  })
})

describe('codes', () => {
  it('to send are six digits, zeros included', () => {
    const codes = Array.from({ length: 200 }, () => numericCode())
    expect(codes.every((code) => /^\d{6}$/.test(code))).toBe(true)
    expect(new Set(codes).size).toBeGreaterThan(190)
    expect(numericCode(8)).toMatch(/^\d{8}$/)
  })

  it('for backup read clearly, and are accepted however they’re typed', () => {
    const code = backupCode()
    expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/)
    expect(backupCode()).not.toBe(code)
    const bare = code.replace('-', '')
    expect(cleanBackupCode(code)).toBe(bare)
    expect(cleanBackupCode(` ${code.toUpperCase().replace('-', ' ')} `)).toBe(bare)
    expect(cleanBackupCode('abcde-fghj')).toBeNull()
    expect(cleanBackupCode('abcde-fghi1')).toBeNull()
    expect(cleanBackupCode('')).toBeNull()
  })
})
