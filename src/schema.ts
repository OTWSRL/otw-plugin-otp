import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

// The plugin's own tables; migrations.ts creates them. Each row is a core user's (cms_users),
// and goes when the user does.

/**
 * The ways a person has set up to get codes: `app` for an authenticator app, otherwise a
 * channel's id (`email`, `sms`). A row is theirs to sign in with once `confirmedAt` is set.
 */
export const methods = pgTable(
  'otp_methods',
  {
    userId: uuid('user_id').notNull(),
    method: text('method').notNull(),
    /** For `app`: its secret, encrypted when the site has a key. */
    secret: text('secret'),
    /** For a channel that needs one: the phone number codes go to. Email uses the account's. */
    address: text('address'),
    /** For `app`: the last thirty-second step a code was accepted for, so none works twice. */
    lastStep: bigint('last_step', { mode: 'number' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.method] })],
)

/** Codes for when a phone is lost: hashed, and used once each. */
export const backupCodes = pgTable(
  'otp_backup_codes',
  {
    userId: uuid('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.codeHash] })],
)

/**
 * Codes sent: for signing in, for setting a way up, and for any form that asks for one. Kept a
 * day, hashed, so how many an address got lately can be counted.
 */
export const challenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `sign-in`, `setup`, or a form's own, such as `contact`. */
    purpose: text('purpose').notNull(),
    channel: text('channel').notNull(),
    /** Where it went, as the channel normalises it. */
    address: text('address').notNull(),
    /** Whose it is, for sign-in and setup; `null` for a visitor's. */
    userId: uuid('user_id'),
    codeHash: text('code_hash').notNull(),
    /** Wrong codes typed against it. */
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** When the right code was typed. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** When what it proved was used: a code proves one thing once. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('otp_challenges_address_idx').on(table.address, table.createdAt),
    index('otp_challenges_user_idx').on(table.userId, table.createdAt),
  ],
)

/** Browsers a person asked not to be asked on again, by the hash of the id core gave them. */
export const devices = pgTable(
  'otp_devices',
  {
    deviceHash: text('device_hash').primaryKey(),
    userId: uuid('user_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('otp_devices_user_idx').on(table.userId)],
)
