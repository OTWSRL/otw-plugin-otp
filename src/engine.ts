import { createHash, randomUUID } from 'node:crypto'
import {
  ActionError,
  type CacheApi,
  type Database,
  type Logger,
  type SignInContext,
  type SignInMethod,
  type User,
} from '@otwdesign/sdk'
import { and, count, desc, eq, gt, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { maskAddress, normalizeAddress, type OtpChannel } from './channels'
import { backupCodes, challenges, devices, methods } from './schema'
import { backupCode, cleanBackupCode, numericCode, sameHash, type Keys } from './secrets'
import { groupSecret, matchTotp, newSecret, otpauthUri } from './totp'

/** The method ids that aren't channels: an authenticator app, and backup codes. */
export const APP = 'app'
export const BACKUP = 'backup'
/** What the plugin's own codes are for; a form names its own purpose. */
export const SIGN_IN = 'sign-in'
export const SETUP = 'setup'

/** How many backup codes a person gets. */
export const BACKUP_CODES = 10
/** Wrong codes one sent code allows before it stops working. */
export const MAX_ATTEMPTS = 5
/** The shortest wait between two codes to one address, in seconds. */
export const RESEND_SECONDS = 60
/** Codes one address may be sent in an hour. */
export const MAX_PER_HOUR = 5
/** Codes one person may be sent in an hour, wherever they go: setting up number after number. */
export const MAX_PER_PERSON = 10
/** How long a code a form checked stays good for the form's own submit, in minutes. */
export const PROOF_MINUTES = 30
/** How long new backup codes stay on the screen that shows them once, in seconds. */
const FRESH_SECONDS = 10 * 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** What Settings says about who is asked, and how. */
export interface Policy {
  /** `OTP_DISABLED`: nobody is asked for a code, for an administrator who is locked out. */
  disabled: boolean
  /** Whether a method may be used: `app`, or a channel's id. */
  allowed(method: string): boolean
  /** The roles whose people must use a code. */
  requiredRoles: ReadonlySet<string>
  /** Days a browser can be remembered for; 0 doesn't offer it. */
  rememberDays: number
  /** Minutes a sent code works for. */
  minutes: number
  /** Codes forms and setups may have sent in an hour, per channel. Signing in doesn't count. */
  hourlyLimit: number
}

export interface EngineOptions {
  /** The current database: a transaction's, inside one. */
  db(): Database
  keys: Keys
  channels(): readonly OtpChannel[]
  policy(): Policy
  /** Keeps new backup codes for the one screen that shows them. */
  cache: Pick<CacheApi, 'get' | 'set' | 'delete'>
  logger: Logger
  /** The site's name, for messages and for the app's label. */
  site(): string
  checkPassword(user: User, password: string): Promise<boolean>
  /** Tells a person, by email and after the request, that their sign-in changed. */
  notify(userId: string, event: NoticeEvent): Promise<void>
  now?: () => Date
}

/** What a person is told about by email, as it could be someone else's doing. */
export type NoticeEvent =
  | { kind: 'added' | 'removed'; method: string }
  | { kind: 'backup-used'; left: number }
  | { kind: 'backup-new' | 'reset' }

/** A code sent for a form. */
export interface SentCode {
  /** What the form sends back with the code, and with its own submit. */
  id: string
  /** Where it went, masked: `a•••@example.com`. */
  to: string
  /** When it stops working, as an ISO date. */
  expiresAt: string
}

/** One way of getting codes, as the setup screens show it. */
export interface WayView {
  id: string
  label: string
  kind: 'app' | OtpChannel['kind']
  /** `unavailable`: turned off in Settings, or with nothing to send through. */
  state: 'off' | 'pending' | 'on' | 'unavailable'
  /** Whether the person has it set up, even if it's `unavailable` now. */
  mine: boolean
  /** Where codes go, masked, once an address is known. */
  to: string | null
  /** While an app is being set up: its secret, grouped for typing, and the QR code's address. */
  secret?: string
  uri?: string
}

/** A person's two-step sign-in, for their own setup screen. */
export interface Overview {
  /** Whether their role must use a code. */
  required: boolean
  /** Whether they're asked for one now. */
  on: boolean
  /** With `required` and no way of their own: codes go to their email address. */
  fallback: boolean
  ways: WayView[]
  backups: { left: number; total: number }
  /** Browsers that won't ask for a code. */
  devices: number
  /** Backup codes just made, shown this once. */
  fresh: string[] | null
}

interface MethodRow {
  method: string
  secret: string | null
  address: string | null
  lastStep: number | null
  confirmed: boolean
}

interface State {
  methods: MethodRow[]
  backupsLeft: number
  backupsTotal: number
  devices: number
  trusted: boolean
}

function hashDevice(device: string): string {
  return createHash('sha256').update(device).digest('hex')
}

const APP_METHOD: SignInMethod = {
  id: APP,
  label: 'Authenticator app',
  prompt: 'Enter the 6-digit code from your authenticator app.',
  numeric: true,
}

const BACKUP_METHOD: SignInMethod = {
  id: BACKUP,
  label: 'Backup code',
  prompt: 'Enter one of your backup codes. Each works once.',
}

export type Engine = ReturnType<typeof createEngine>

/** Everything the plugin does with codes: sending, checking, and people's ways of getting them. */
export function createEngine(options: EngineOptions) {
  const { keys, logger } = options
  const db = () => options.db()
  const now = options.now ?? (() => new Date())
  const ago = (ms: number) => new Date(now().getTime() - ms)

  /** A channel people may use: on in Settings. */
  const channel = (id: string): OtpChannel | null =>
    options.policy().allowed(id)
      ? (options.channels().find((candidate) => candidate.id === id) ?? null)
      : null

  /** A person's ways, backup codes and remembered browsers, in one query. */
  const state = async (userId: string, device: string | null = null): Promise<State> => {
    const at = now().toISOString()
    const trusted = device
      ? sql`EXISTS (SELECT 1 FROM otp_devices WHERE device_hash = ${hashDevice(device)} AND user_id = ${userId} AND expires_at > ${at}::timestamptz)`
      : sql`false`
    const result = (await db().execute(sql`
      SELECT
        (SELECT coalesce(json_agg(json_build_object(
            'method', method, 'secret', secret, 'address', address,
            'lastStep', last_step, 'confirmed', confirmed_at IS NOT NULL) ORDER BY created_at), '[]'::json)
           FROM otp_methods WHERE user_id = ${userId}) AS methods,
        (SELECT count(*)::int FROM otp_backup_codes
          WHERE user_id = ${userId} AND used_at IS NULL) AS "backupsLeft",
        (SELECT count(*)::int FROM otp_backup_codes WHERE user_id = ${userId}) AS "backupsTotal",
        (SELECT count(*)::int FROM otp_devices
          WHERE user_id = ${userId} AND expires_at > ${at}::timestamptz) AS devices,
        ${trusted} AS trusted
    `)) as unknown as { rows: (Omit<State, 'methods'> & { methods: MethodRow[] | string })[] }
    const row = result.rows[0]!
    return {
      ...row,
      methods: typeof row.methods === 'string' ? JSON.parse(row.methods) : row.methods,
    }
  }

  // ── Codes that are sent ──────────────────────────────────────────────────────

  /**
   * Sends a new code to an address, within its limits: one a minute and five an hour to the
   * address, ten an hour to a person, and the channel's hourly limit for everything but
   * signing in, so neither a form nor an account can flood an inbox or run up the SMS bill.
   */
  const issue = async (input: {
    channel: OtpChannel
    address: string
    purpose: string
    userId: string | null
  }): Promise<SentCode> => {
    const policy = options.policy()
    const [recent] = await db()
      .select({
        hour: count(),
        minute:
          sql<number>`count(*) FILTER (WHERE ${challenges.createdAt} > ${ago(RESEND_SECONDS * 1000).toISOString()}::timestamptz)`.mapWith(
            Number,
          ),
      })
      .from(challenges)
      .where(and(eq(challenges.address, input.address), gt(challenges.createdAt, ago(HOUR_MS))))
    if ((recent?.minute ?? 0) > 0) {
      throw new ActionError('Wait a minute before asking for another code.')
    }
    if ((recent?.hour ?? 0) >= MAX_PER_HOUR) {
      throw new ActionError('Too many codes were sent there. Try again in an hour.')
    }
    if (input.userId !== null) {
      const [own] = await db()
        .select({ sent: count() })
        .from(challenges)
        .where(and(eq(challenges.userId, input.userId), gt(challenges.createdAt, ago(HOUR_MS))))
      if ((own?.sent ?? 0) >= MAX_PER_PERSON) {
        throw new ActionError('Too many codes were sent. Try again in an hour.')
      }
    }
    // A sign-in's code goes to an address its owner confirmed. Anything else can name any
    // address, a form's or a setup's, so the site as a whole sends only so many an hour.
    if (input.purpose !== SIGN_IN) {
      const [all] = await db()
        .select({ sent: count() })
        .from(challenges)
        .where(
          and(
            eq(challenges.channel, input.channel.id),
            ne(challenges.purpose, SIGN_IN),
            gt(challenges.createdAt, ago(HOUR_MS)),
          ),
        )
      if ((all?.sent ?? 0) >= policy.hourlyLimit) {
        logger.warn('OTP: the hourly limit for codes sent by forms and setups was reached', {
          channel: input.channel.id,
          limit: policy.hourlyLimit,
        })
        throw new ActionError('Codes can’t be sent right now. Try again later.')
      }
    }

    const id = randomUUID()
    const code = numericCode()
    const at = now()
    // A person's newest code is the only one that works: asking again ends the one before.
    if (input.userId !== null) {
      await db()
        .update(challenges)
        .set({ consumedAt: at })
        .where(
          and(
            eq(challenges.userId, input.userId),
            eq(challenges.purpose, input.purpose),
            eq(challenges.channel, input.channel.id),
            isNull(challenges.consumedAt),
          ),
        )
    }
    const expiresAt = new Date(at.getTime() + policy.minutes * 60 * 1000)
    await db()
      .insert(challenges)
      .values({
        id,
        purpose: input.purpose,
        channel: input.channel.id,
        address: input.address,
        userId: input.userId,
        codeHash: keys.hash(id, code),
        createdAt: at,
        expiresAt,
      })
    try {
      await input.channel.send(input.address, {
        code,
        minutes: policy.minutes,
        site: options.site(),
        purpose: input.purpose,
      })
    } catch (error) {
      // Not sent: it mustn't count against the address, which can ask again at once.
      await db().delete(challenges).where(eq(challenges.id, id))
      logger.error('OTP: a code could not be sent', { channel: input.channel.id, error })
      throw new ActionError('We couldn’t send your code. Try again later.')
    }
    return {
      id,
      to: maskAddress(input.channel.kind, input.address),
      expiresAt: expiresAt.toISOString(),
    }
  }

  /** Whether `code` is the one a sent code's row holds; a wrong one is counted against it. */
  const matches = async (
    row: { id: string; codeHash: string; attempts: number; expiresAt: Date },
    code: string,
  ): Promise<boolean> => {
    if (row.attempts >= MAX_ATTEMPTS || row.expiresAt <= now()) return false
    if (/^\d{6}$/.test(code) && sameHash(row.codeHash, keys.hash(row.id, code))) return true
    await db()
      .update(challenges)
      .set({ attempts: sql`${challenges.attempts} + 1` })
      .where(eq(challenges.id, row.id))
    return false
  }

  /** The newest code a person was sent for a purpose on a channel, while it can still be used. */
  const latestFor = async (userId: string, purpose: string, channelId: string) => {
    const [row] = await db()
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.userId, userId),
          eq(challenges.purpose, purpose),
          eq(challenges.channel, channelId),
          isNull(challenges.consumedAt),
          gt(challenges.expiresAt, now()),
        ),
      )
      .orderBy(desc(challenges.createdAt))
      .limit(1)
    return row ?? null
  }

  /** Checks a person's code for a purpose, and uses it up when it's right. */
  const redeem = async (userId: string, purpose: string, channelId: string, code: string) => {
    const row = await latestFor(userId, purpose, channelId)
    if (!row || !(await matches(row, code))) return null
    await db().update(challenges).set({ consumedAt: now() }).where(eq(challenges.id, row.id))
    return row
  }

  // ── Backup codes ─────────────────────────────────────────────────────────────

  const freshKey = (userId: string) => `backup-codes:${userId}`

  /** Replaces a person's backup codes, and keeps the new ones for the screen that shows them. */
  const makeBackupCodes = async (userId: string): Promise<void> => {
    const codes = Array.from({ length: BACKUP_CODES }, backupCode)
    await db().delete(backupCodes).where(eq(backupCodes.userId, userId))
    await db()
      .insert(backupCodes)
      .values(
        codes.map((code) => ({
          userId,
          codeHash: keys.hash(userId, cleanBackupCode(code)!),
          createdAt: now(),
        })),
      )
    await options.cache.set(freshKey(userId), keys.seal(JSON.stringify(codes)), {
      ttlSeconds: FRESH_SECONDS,
      durable: true,
    })
  }

  const freshBackupCodes = async (userId: string): Promise<string[] | null> => {
    const stored = await options.cache.get<string>(freshKey(userId), { durable: true })
    const opened = stored ? keys.open(stored) : null
    return opened ? (JSON.parse(opened) as string[]) : null
  }

  // ── Signing in ───────────────────────────────────────────────────────────────

  const channelMethod = (way: OtpChannel, address: string): SignInMethod => ({
    id: way.id,
    label: way.label,
    prompt: `Enter the 6-digit code we sent to ${maskAddress(way.kind, address)}.`,
    sends: true,
    numeric: true,
  })

  /** The confirmed ways of a person's that work now: on in Settings, with something to send through. */
  const usable = (user: User, rows: readonly MethodRow[]) => {
    const policy = options.policy()
    const confirmed = rows.filter((row) => row.confirmed)
    const ways: { method: SignInMethod; kind: WayView['kind'] }[] = []
    if (policy.allowed(APP) && confirmed.some((row) => row.method === APP)) {
      ways.push({ method: APP_METHOD, kind: 'app' })
    }
    // A phone before an inbox: what a stolen password alone is least likely to reach.
    const sorted = [...options.channels()].sort(
      (a, b) => Number(a.kind === 'email') - Number(b.kind === 'email'),
    )
    for (const way of sorted) {
      const row = confirmed.find((candidate) => candidate.method === way.id)
      if (!row || !policy.allowed(way.id) || !way.ready()) continue
      const address = way.kind === 'email' ? user.email : row.address
      if (address) ways.push({ method: channelMethod(way, address), kind: way.kind })
    }
    return ways
  }

  /** Whether a person with no way of their own gets codes by email: their role requires one. */
  const emailFallback = (user: User): OtpChannel | null => {
    if (!options.policy().requiredRoles.has(user.role)) return null
    const email = channel('email')
    if (email?.ready()) return email
    logger.warn('OTP: a role must use a code, but the site has no way to email one', {
      role: user.role,
    })
    return null
  }

  const signInMethods = async (user: User, context: SignInContext): Promise<SignInMethod[]> => {
    if (options.policy().disabled) return []
    const current = await state(user.id, context.device)
    if (current.trusted) return []
    let ways = usable(user, current.methods)
    const own = ways.length > 0
    if (!own) {
      const fallback = emailFallback(user)
      if (fallback) ways = [{ method: channelMethod(fallback, user.email), kind: 'email' }]
    }
    // An emailed link has just proved the inbox: a code sent there would prove it again.
    if (context.via === 'link') ways = ways.filter((way) => way.kind !== 'email')
    if (ways.length === 0) return []
    const list = ways.map((way) => way.method)
    return own && current.backupsLeft > 0 ? [...list, BACKUP_METHOD] : list
  }

  const sendSignInCode = async (user: User, method: string): Promise<void> => {
    const way = channel(method)
    if (!way?.ready()) throw new ActionError('That way isn’t available right now. Try another.')
    let address: string | null = user.email
    if (way.kind !== 'email') {
      const [row] = await db()
        .select({ address: methods.address })
        .from(methods)
        .where(
          and(
            eq(methods.userId, user.id),
            eq(methods.method, method),
            isNotNull(methods.confirmedAt),
          ),
        )
        .limit(1)
      address = row?.address ?? null
    }
    if (!address) throw new ActionError('That way isn’t set up.')
    await issue({ channel: way, address, purpose: SIGN_IN, userId: user.id })
  }

  /** Checks an app's code, and remembers its step so the same code can't be used again. */
  const verifyApp = async (userId: string, code: string): Promise<boolean> => {
    const [row] = await db()
      .select({ secret: methods.secret, lastStep: methods.lastStep })
      .from(methods)
      .where(
        and(eq(methods.userId, userId), eq(methods.method, APP), isNotNull(methods.confirmedAt)),
      )
      .limit(1)
    if (!row?.secret) return false
    const secret = keys.open(row.secret)
    if (secret === null) {
      logger.error('OTP: an app’s secret can’t be read; was OTP_SECRET_KEY changed?', { userId })
      return false
    }
    const step = matchTotp(secret, code, now().getTime(), row.lastStep)
    if (step === null) return false
    // Only if no later step was taken meanwhile: two requests with one code, one wins.
    const taken = await db()
      .update(methods)
      .set({ lastStep: step })
      .where(
        and(
          eq(methods.userId, userId),
          eq(methods.method, APP),
          or(isNull(methods.lastStep), lt(methods.lastStep, step)),
        ),
      )
      .returning({ method: methods.method })
    return taken.length > 0
  }

  const verifyBackup = async (userId: string, typed: string): Promise<boolean> => {
    const code = cleanBackupCode(typed)
    if (!code) return false
    const used = await db()
      .update(backupCodes)
      .set({ usedAt: now() })
      .where(
        and(
          eq(backupCodes.userId, userId),
          eq(backupCodes.codeHash, keys.hash(userId, code)),
          isNull(backupCodes.usedAt),
        ),
      )
      .returning({ userId: backupCodes.userId })
    if (used.length === 0) return false
    const [left] = await db()
      .select({ left: count() })
      .from(backupCodes)
      .where(and(eq(backupCodes.userId, userId), isNull(backupCodes.usedAt)))
    await options.notify(userId, { kind: 'backup-used', left: left?.left ?? 0 })
    return true
  }

  const verifySignIn = async (user: User, method: string, code: string): Promise<boolean> => {
    if (method === APP) return options.policy().allowed(APP) && verifyApp(user.id, code)
    if (method === BACKUP) return verifyBackup(user.id, code)
    return channel(method) ? (await redeem(user.id, SIGN_IN, method, code)) !== null : false
  }

  const rememberDevice = async (user: User, device: string, days: number): Promise<void> => {
    await db()
      .insert(devices)
      .values({
        deviceHash: hashDevice(device),
        userId: user.id,
        createdAt: now(),
        expiresAt: new Date(now().getTime() + days * DAY_MS),
      })
      .onConflictDoNothing()
  }

  // ── Setting ways up ──────────────────────────────────────────────────────────

  const methodRow = async (userId: string, method: string) => {
    const [row] = await db()
      .select()
      .from(methods)
      .where(and(eq(methods.userId, userId), eq(methods.method, method)))
      .limit(1)
    return row ?? null
  }

  /** After a way is confirmed: backup codes for someone who has none, and an email about it. */
  const confirmed = async (userId: string, method: string): Promise<void> => {
    await db()
      .update(methods)
      .set({ confirmedAt: now() })
      .where(and(eq(methods.userId, userId), eq(methods.method, method)))
    const [existing] = await db()
      .select({ codes: count() })
      .from(backupCodes)
      .where(eq(backupCodes.userId, userId))
    if ((existing?.codes ?? 0) === 0) await makeBackupCodes(userId)
    await options.notify(userId, { kind: 'added', method })
  }

  const overview = async (user: User): Promise<Overview> => {
    const policy = options.policy()
    const [current, fresh] = await Promise.all([state(user.id), freshBackupCodes(user.id)])
    const rowOf = (id: string) => current.methods.find((row) => row.method === id)
    const stateOf = (row: MethodRow | undefined, available: boolean): WayView['state'] =>
      row?.confirmed
        ? available
          ? 'on'
          : 'unavailable'
        : !available
          ? 'unavailable'
          : row
            ? 'pending'
            : 'off'

    const app = rowOf(APP)
    const secret = app && !app.confirmed && app.secret ? keys.open(app.secret) : null
    const ways: WayView[] = [
      {
        id: APP,
        label: APP_METHOD.label,
        kind: 'app',
        state: stateOf(app, policy.allowed(APP)),
        mine: app?.confirmed === true,
        to: null,
        ...(secret
          ? {
              secret: groupSecret(secret),
              uri: otpauthUri({ secret, account: user.email, issuer: options.site() }),
            }
          : {}),
      },
      ...options.channels().map((way): WayView => {
        const row = rowOf(way.id)
        const address = way.kind === 'email' ? user.email : (row?.address ?? null)
        return {
          id: way.id,
          label: way.label,
          kind: way.kind,
          state: stateOf(row, policy.allowed(way.id) && way.ready()),
          mine: row?.confirmed === true,
          to: address && (row || way.kind === 'email') ? maskAddress(way.kind, address) : null,
        }
      }),
    ]
    const own = usable(user, current.methods).length > 0
    const required = policy.requiredRoles.has(user.role)
    const fallback = !own && required && channel('email')?.ready() === true
    return {
      required,
      on: !policy.disabled && (own || fallback),
      fallback,
      ways,
      backups: { left: current.backupsLeft, total: current.backupsTotal },
      devices: current.devices,
      fresh,
    }
  }

  const startApp = async (user: User): Promise<void> => {
    if (!options.policy().allowed(APP)) throw new ActionError('Authenticator apps are turned off.')
    const existing = await methodRow(user.id, APP)
    if (existing?.confirmedAt) throw new ActionError('Your authenticator app is already set up.')
    const secret = keys.seal(newSecret())
    await db()
      .insert(methods)
      .values({ userId: user.id, method: APP, secret, createdAt: now() })
      .onConflictDoUpdate({
        target: [methods.userId, methods.method],
        set: { secret, lastStep: null, createdAt: now() },
      })
  }

  const confirmApp = async (user: User, code: string): Promise<void> => {
    const row = await methodRow(user.id, APP)
    if (!row?.secret || row.confirmedAt) throw new ActionError('Start setting up your app first.')
    const secret = keys.open(row.secret)
    const step = secret ? matchTotp(secret, code.replace(/\s+/g, ''), now().getTime()) : null
    if (step === null) {
      throw new ActionError(
        'That code isn’t right. Check that your phone sets its time automatically, and try the next code.',
      )
    }
    await db()
      .update(methods)
      .set({ lastStep: step })
      .where(and(eq(methods.userId, user.id), eq(methods.method, APP)))
    await confirmed(user.id, APP)
  }

  /** Gives up on a way that was being set up. */
  const cancelSetup = async (user: User, method: string): Promise<void> => {
    await db()
      .delete(methods)
      .where(
        and(eq(methods.userId, user.id), eq(methods.method, method), isNull(methods.confirmedAt)),
      )
  }

  /** Starts setting a channel up: remembers the number, for a phone, and sends a code there. */
  const startChannel = async (user: User, channelId: string, to = ''): Promise<SentCode> => {
    const way = channel(channelId)
    if (!way?.ready()) throw new ActionError('That way isn’t available on this site.')
    const existing = await methodRow(user.id, way.id)
    if (existing?.confirmedAt) throw new ActionError(`${way.label} is already set up.`)
    // "Send a new code" names no number: it's the one being set up.
    const typed = way.kind === 'email' ? user.email : to || existing?.address || ''
    const address = normalizeAddress(way.kind, typed)
    if (!address) {
      throw new ActionError('Enter the number with its country code, such as +39 333 123 4567.')
    }
    const stored = way.kind === 'email' ? null : address
    await db()
      .insert(methods)
      .values({ userId: user.id, method: way.id, address: stored, createdAt: now() })
      .onConflictDoUpdate({
        target: [methods.userId, methods.method],
        set: { address: stored, createdAt: now() },
      })
    try {
      return await issue({ channel: way, address, purpose: SETUP, userId: user.id })
    } catch (error) {
      // Nothing was sent for a setup just begun: there is no code to ask for.
      if (!existing) await cancelSetup(user, way.id)
      throw error
    }
  }

  const confirmChannel = async (user: User, channelId: string, code: string): Promise<void> => {
    const way = channel(channelId)
    const row = way ? await methodRow(user.id, way.id) : null
    if (!way || !row || row.confirmedAt) throw new ActionError('Ask for a code first.')
    const address = way.kind === 'email' ? normalizeAddress('email', user.email) : row.address
    const sent = await latestFor(user.id, SETUP, way.id)
    // The code must have gone to the address being set up, not to one asked for before it.
    if (!sent || sent.address !== address || !(await matches(sent, code.replace(/\s+/g, '')))) {
      throw new ActionError('That code isn’t right, or it has run out. Ask for a new one.')
    }
    await db().update(challenges).set({ consumedAt: now() }).where(eq(challenges.id, sent.id))
    await confirmed(user.id, way.id)
  }

  /** What goes with a person's last way: their backup codes and remembered browsers. */
  const clearIfLast = async (userId: string): Promise<void> => {
    const [left] = await db()
      .select({ ways: count() })
      .from(methods)
      .where(and(eq(methods.userId, userId), isNotNull(methods.confirmedAt)))
    if ((left?.ways ?? 0) > 0) return
    await db().delete(backupCodes).where(eq(backupCodes.userId, userId))
    await db().delete(devices).where(eq(devices.userId, userId))
    await options.cache.delete(freshKey(userId), { durable: true })
  }

  /** Removes one of a person's ways, once they've typed their password. */
  const remove = async (user: User, method: string, password: string): Promise<void> => {
    if (!(await options.checkPassword(user, password))) {
      throw new ActionError('Your password is incorrect.')
    }
    const removed = await db()
      .delete(methods)
      .where(
        and(
          eq(methods.userId, user.id),
          eq(methods.method, method),
          isNotNull(methods.confirmedAt),
        ),
      )
      .returning({ method: methods.method })
    if (removed.length === 0) throw new ActionError('That way isn’t set up.')
    await clearIfLast(user.id)
    await options.notify(user.id, { kind: 'removed', method })
  }

  const newBackupCodes = async (user: User): Promise<void> => {
    const [own] = await db()
      .select({ ways: count() })
      .from(methods)
      .where(and(eq(methods.userId, user.id), isNotNull(methods.confirmedAt)))
    if ((own?.ways ?? 0) === 0) {
      throw new ActionError('Set up a way to get codes first: backup codes stand in for it.')
    }
    await makeBackupCodes(user.id)
    await options.notify(user.id, { kind: 'backup-new' })
  }

  /** The person has their new backup codes: they're shown no more. */
  const dismissBackupCodes = (user: User): Promise<void> =>
    options.cache.delete(freshKey(user.id), { durable: true })

  const forgetDevices = async (userId: string): Promise<void> => {
    await db().delete(devices).where(eq(devices.userId, userId))
  }

  /** An administrator's reset for someone locked out: every way, code and browser of theirs. */
  const reset = async (userId: string): Promise<void> => {
    await db().delete(methods).where(eq(methods.userId, userId))
    await db().delete(backupCodes).where(eq(backupCodes.userId, userId))
    await db().delete(devices).where(eq(devices.userId, userId))
    await db().delete(challenges).where(eq(challenges.userId, userId))
    await options.cache.delete(freshKey(userId), { durable: true })
    await options.notify(userId, { kind: 'reset' })
  }

  /** Someone's ways, by id, and the backup codes they have left: for whoever manages users. */
  const statusOf = async (userId: string): Promise<{ methods: string[]; backupCodes: number }> => {
    if (!UUID.test(userId)) return { methods: [], backupCodes: 0 }
    const current = await state(userId)
    return {
      methods: current.methods.filter((row) => row.confirmed).map((row) => row.method),
      backupCodes: current.backupsLeft,
    }
  }

  /** How many people have each way set up, and how many have any. */
  const stats = async (): Promise<{ people: number; byMethod: Record<string, number> }> => {
    const rows = await db()
      .select({ method: methods.method, people: count() })
      .from(methods)
      .where(isNotNull(methods.confirmedAt))
      .groupBy(methods.method)
    const [any] = await db()
      .select({ people: sql<number>`count(DISTINCT ${methods.userId})`.mapWith(Number) })
      .from(methods)
      .where(isNotNull(methods.confirmedAt))
    return {
      people: any?.people ?? 0,
      byMethod: Object.fromEntries(rows.map((row) => [row.method, row.people])),
    }
  }

  /** The daily clean-up: codes sent over a day ago, browsers no longer remembered, setups left unfinished. */
  const cleanup = async (): Promise<void> => {
    await db()
      .delete(challenges)
      .where(lt(challenges.createdAt, ago(DAY_MS)))
    await db().delete(devices).where(lt(devices.expiresAt, now()))
    await db()
      .delete(methods)
      .where(and(isNull(methods.confirmedAt), lt(methods.createdAt, ago(DAY_MS))))
  }

  // ── Codes for any form ───────────────────────────────────────────────────────

  /** Sends a visitor a code for a form. */
  const send = async (input: {
    channel: string
    to: string
    purpose: string
  }): Promise<SentCode> => {
    const way = channel(input.channel)
    if (!way?.ready()) throw new ActionError('Codes can’t be sent that way on this site.')
    const address = normalizeAddress(way.kind, input.to)
    if (!address) {
      throw new ActionError(
        way.kind === 'email'
          ? 'Enter a valid email address.'
          : 'Enter the number with its country code, such as +39 333 123 4567.',
      )
    }
    return issue({ channel: way, address, purpose: input.purpose, userId: null })
  }

  /** Whether `code` is the one sent as `id`. A right one stays right until the form uses it. */
  const check = async (id: string, code: string): Promise<boolean> => {
    if (!UUID.test(id)) return false
    const [row] = await db()
      .select()
      .from(challenges)
      .where(and(eq(challenges.id, id), isNull(challenges.userId), isNull(challenges.consumedAt)))
      .limit(1)
    if (!row || !(await matches(row, code.replace(/\s+/g, '')))) return false
    if (!row.verifiedAt) {
      await db().update(challenges).set({ verifiedAt: now() }).where(eq(challenges.id, id))
    }
    return true
  }

  /**
   * Whether the code sent as `id` was checked, for this address and purpose, and uses that up:
   * what a form's own handler asks before it trusts the address.
   */
  const consume = async (
    id: string,
    expected: { to: string; purpose: string },
  ): Promise<boolean> => {
    if (!UUID.test(id)) return false
    const [row] = await db()
      .select({ channel: challenges.channel, address: challenges.address })
      .from(challenges)
      .where(eq(challenges.id, id))
      .limit(1)
    const way = row ? options.channels().find((candidate) => candidate.id === row.channel) : null
    if (!row || !way || normalizeAddress(way.kind, expected.to) !== row.address) return false
    const used = await db()
      .update(challenges)
      .set({ consumedAt: now() })
      .where(
        and(
          eq(challenges.id, id),
          eq(challenges.purpose, expected.purpose),
          isNull(challenges.userId),
          isNull(challenges.consumedAt),
          gt(challenges.verifiedAt, ago(PROOF_MINUTES * 60 * 1000)),
        ),
      )
      .returning({ id: challenges.id })
    return used.length > 0
  }

  return {
    signInMethods,
    sendSignInCode,
    verifySignIn,
    rememberDevice,
    overview,
    startApp,
    confirmApp,
    startChannel,
    confirmChannel,
    cancelSetup,
    remove,
    newBackupCodes,
    dismissBackupCodes,
    forgetDevices,
    reset,
    statusOf,
    stats,
    cleanup,
    send,
    check,
    consume,
  }
}
