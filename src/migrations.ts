import type { Migration } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'

/** The plugin's tables, each tied to core's users so deleting a user takes their rows along. */
export const migrations: readonly Migration[] = [
  {
    id: '0001_tables',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE otp_methods (
          user_id uuid NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
          method text NOT NULL,
          secret text,
          address text,
          last_step bigint,
          confirmed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, method)
        )
      `)
      await db.execute(sql`
        CREATE TABLE otp_backup_codes (
          user_id uuid NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
          code_hash text NOT NULL,
          used_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, code_hash)
        )
      `)
      await db.execute(sql`
        CREATE TABLE otp_challenges (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          purpose text NOT NULL,
          channel text NOT NULL,
          address text NOT NULL,
          user_id uuid REFERENCES cms_users(id) ON DELETE CASCADE,
          code_hash text NOT NULL,
          attempts integer NOT NULL DEFAULT 0,
          expires_at timestamptz NOT NULL,
          verified_at timestamptz,
          consumed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE INDEX otp_challenges_address_idx ON otp_challenges (address, created_at)`,
      )
      await db.execute(
        sql`CREATE INDEX otp_challenges_user_idx ON otp_challenges (user_id, created_at)`,
      )
      await db.execute(sql`
        CREATE TABLE otp_devices (
          device_hash text PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`CREATE INDEX otp_devices_user_idx ON otp_devices (user_id)`)
    },
  },
]

/** What `uninstall()` drops: every table above. */
export const TABLES = ['otp_devices', 'otp_challenges', 'otp_backup_codes', 'otp_methods'] as const
