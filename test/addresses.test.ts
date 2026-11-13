import { describe, expect, it } from 'vitest'
import { maskEmail, maskPhone, normalizeEmail, normalizePhone } from '../src/addresses'

describe('email addresses', () => {
  it('are kept lowercase and trimmed', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com')
    for (const bad of ['', 'ada', 'ada@', '@example.com', 'a b@example.com', 'ada@example']) {
      expect(normalizeEmail(bad)).toBeNull()
    }
    expect(normalizeEmail(`${'a'.repeat(250)}@example.com`)).toBeNull()
  })

  it('are shown without giving them away', () => {
    expect(maskEmail('ada@example.com')).toBe('a•••@example.com')
    expect(maskEmail('@example.com')).toBe('•••')
  })
})

describe('phone numbers', () => {
  it('are kept in E.164, however they were typed', () => {
    expect(normalizePhone('+39 333 123 4567')).toBe('+393331234567')
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671')
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958')
    expect(normalizePhone('+92.300.1234567')).toBe('+923001234567')
  })

  it('need their country code', () => {
    for (const bad of [
      '',
      '3331234567',
      '+0123456789',
      '+12',
      '+1234567890123456',
      '+39 abc',
      'x',
    ]) {
      expect(normalizePhone(bad)).toBeNull()
    }
  })

  it('are shown by their last two digits', () => {
    expect(maskPhone('+393331234567')).toBe('the number ending in 67')
  })
})
