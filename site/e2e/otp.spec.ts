import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { totp } from '../../src/totp'

// One site, set up by the first test; the rest build on it, in order. The administrator's own
// browser stays signed in throughout; signing in is tested from other, fresh browsers.
test.describe.configure({ mode: 'serial' })

const DATA = join(import.meta.dirname, '..', '.data')
const ADMIN = { name: 'Ada Admin', email: 'ada@example.com', password: 'a strong e2e password' }
const run = Date.now().toString(36)
const EDITOR = { email: `ed-${run}@example.com`, password: 'another e2e password' }
const PHONE = '+393331234567'

let admin: Page
/** The administrator's app secret and backup codes, as the screens showed them. */
let secret = ''
let backupCodes: string[] = []
/** When the phone number last got a text: a number gets one a minute. */
let textedAt = 0

interface Mail {
  to: string[]
  subject: string
  text: string
}

async function newest<T>(folder: string, wanted: (item: T) => boolean, what: string): Promise<T> {
  let found: T | null = null
  await expect
    .poll(
      async () => {
        const dir = join(DATA, folder)
        const files = (await readdir(dir).catch(() => [] as string[]))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .reverse()
        for (const name of files) {
          const item = JSON.parse(await readFile(join(dir, name), 'utf8')) as T
          if (wanted(item)) return (found = item)
        }
        return null
      },
      { message: what },
    )
    .toBeTruthy()
  return found!
}

/** The code in the newest email to an address about a subject. */
async function emailedCode(to: string, subject: string): Promise<string> {
  const mail = await newest<Mail>(
    'e2e-mail',
    (item) => item.to.includes(to) && item.subject.endsWith(subject),
    `an email to ${to} about "${subject}"`,
  )
  return /Your code is (\d{6})\./.exec(mail.text)![1]!
}

/** The newest text message to a number that says what's wanted. */
async function text(to: string, wanted: RegExp): Promise<string> {
  const sms = await newest<{ to: string; text: string }>(
    'e2e-sms',
    (item) => item.to === to && wanted.test(item.text),
    `a text to ${to} matching ${wanted}`,
  )
  return sms.text
}

/** A row of an admin form table, which is laid out as a table without being one to a reader. */
const row = (page: Page, label: string) =>
  page.locator('tr').filter({ has: page.locator('th', { hasText: new RegExp(`^${label}$`) }) })

const notice = (page: Page, message: string | RegExp) =>
  expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
const error = (page: Page, message: string | RegExp) =>
  expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible()

/** The password step, in a browser of its own. */
async function logIn(browser: Browser, user: { email: string; password: string }, path = '/admin') {
  // A context of its own, so the test can open a second tab in the same browser.
  const page = await (await browser.newContext()).newPage()
  await page.goto(path)
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Log In' }).click()
  return page
}

test.beforeAll(async ({ browser }) => {
  admin = await browser.newPage()
})

test('the first visit sets the site up, and OTP says what it can use', async () => {
  await admin.goto('/admin')
  await expect(admin).toHaveURL('/admin/setup')
  await admin.getByLabel('Name').fill(ADMIN.name)
  await admin.getByLabel('Email').fill(ADMIN.email)
  await admin.getByLabel('Password').fill(ADMIN.password)
  await admin.getByRole('button', { name: 'Create administrator' }).click()
  await notice(admin, 'Your site is ready.')

  await admin.goto('/admin/otp')
  await expect(admin.getByRole('heading', { name: 'OTP', level: 1 })).toBeVisible()
  await expect(row(admin, 'People using it')).toContainText('No one yet')
  await expect(row(admin, 'Email')).toContainText('Ready')
  await expect(row(admin, 'Text message')).toContainText('Turned off in Settings')
  await expect(row(admin, 'App secrets')).toContainText('Encrypted with OTP_SECRET_KEY')
})

test('settings show a provider’s fields only once it’s chosen, and its test goes through it', async () => {
  await admin.goto('/admin/otp/settings')
  await expect(admin.getByRole('heading', { name: 'OTP Settings' })).toBeVisible()
  // Text messages are off: nothing about them shows.
  const provider = admin.getByLabel('Send text messages through')
  await expect(provider).toBeHidden()
  await expect(admin.getByRole('heading', { name: 'Twilio account' })).toBeHidden()

  await admin.getByRole('checkbox', { name: 'Text message' }).check()
  // Twilio, until another is chosen: its sender and its account, and nothing of the others.
  await expect(provider).toHaveValue('twilio')
  await expect(admin.getByLabel('Twilio sender')).toBeVisible()
  await expect(admin.getByRole('heading', { name: 'Twilio account' })).toBeVisible()
  await expect(admin.getByLabel('Request URL')).toBeHidden()

  await provider.selectOption('http')
  await expect(admin.getByLabel('Twilio sender')).toBeHidden()
  await expect(admin.getByRole('heading', { name: 'Twilio account' })).toBeHidden()
  // The address and the token come from the server's environment.
  await expect(admin.getByLabel('Request URL')).toBeDisabled()
  await expect(admin.getByRole('group', { name: 'Headers' })).toBeHidden()
  await admin.getByLabel('Authorization').selectOption('headers')
  await expect(admin.getByRole('group', { name: 'Headers' })).toBeVisible()
  await admin.getByLabel('Authorization').selectOption('bearer')
  await expect(admin.getByLabel('Body template')).toBeHidden()
  await admin.getByLabel('Body', { exact: true }).selectOption('template')
  await expect(admin.getByLabel('Body template')).toBeVisible()
  await admin.getByLabel('Body', { exact: true }).selectOption('json')

  await admin.getByLabel('Remember a browser').selectOption('30')
  await admin.getByRole('button', { name: 'Save Changes' }).click()
  await notice(admin, 'Settings saved.')
  // As it was left: the HTTP request's fields, without choosing again.
  await expect(admin.getByLabel('Request URL')).toBeVisible()

  await admin.getByRole('link', { name: 'Send a Test Message' }).click()
  await expect(admin).toHaveURL('/admin/otp#test-sms')
  await expect(row(admin, 'Text message')).toContainText('Ready, through HTTP request')
  const test = admin.locator('#test-sms')
  await test.getByLabel('Mobile number').fill('+39 333 999 0000')
  await test.getByRole('button', { name: 'Send Test by Text message' }).click()
  await notice(admin, 'A Text message test was accepted for +393339990000.')
  expect(await text('+393339990000', /^123456 is your/)).toBe(
    '123456 is your My Site code. It works for 10 minutes.',
  )
})

test('WhatsApp codes go through the Cloud API as the approved template', async () => {
  await admin.goto('/admin/otp/settings')
  await expect(admin.getByLabel('Send WhatsApp codes through')).toBeHidden()
  await admin.getByRole('checkbox', { name: 'WhatsApp' }).check()
  await expect(admin.getByLabel('Send WhatsApp codes through')).toHaveValue('meta')
  await admin.getByLabel('Phone number ID').fill('106540352242922')
  await admin.getByLabel('Template name').fill('sign_in_code')
  await expect(admin.getByLabel('Content template SID')).toBeHidden()
  await admin.getByRole('button', { name: 'Save Changes' }).click()
  await notice(admin, 'Settings saved.')

  await admin.getByRole('link', { name: 'Send a Test by WhatsApp' }).click()
  await expect(row(admin, 'WhatsApp')).toContainText('Ready, through WhatsApp Cloud API')
  const test = admin.locator('#test-whatsapp')
  await test.getByLabel('Mobile number').fill('+39 333 888 0000')
  await test.getByRole('button', { name: 'Send Test by WhatsApp' }).click()
  await notice(admin, 'A WhatsApp test was accepted for +393338880000.')
  expect(await text('+393338880000', /^whatsapp /)).toBe('whatsapp sign_in_code en_US 123456')
})

test('they set up an authenticator app on their Profile, and save their backup codes', async () => {
  await admin.goto('/admin/profile')
  const section = admin.getByRole('region', { name: 'Two-step sign-in' })
  await expect(section).toContainText('Off: you sign in with your password alone.')
  await section.getByRole('button', { name: 'Set up an app' }).click()

  await expect(
    section.getByRole('img', { name: 'QR code for your authenticator app' }),
  ).toBeVisible()
  secret = ((await section.locator('.otp-steps code').textContent()) ?? '').replace(/ /g, '')
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  await section.getByLabel('Code from the app').fill('000000')
  await section.getByRole('button', { name: 'Turn on' }).click()
  await error(admin, /That code isn’t right/)

  await section.getByLabel('Code from the app').fill(totp(secret, Date.now()))
  await section.getByRole('button', { name: 'Turn on' }).click()
  await notice(admin, /Your authenticator app is set up/)
  await expect(section).toContainText('On: after your password, you’re asked for a code.')

  const fresh = section.getByRole('group', { name: 'Save your backup codes' })
  backupCodes = await fresh.locator('.otp-codes code').allTextContents()
  expect(backupCodes).toHaveLength(10)
  await fresh.getByRole('button', { name: 'I’ve saved them' }).click()
  await expect(fresh).toHaveCount(0)
  await expect(section).toContainText('You have 10 of 10 left.')
  // Shown once: the page no longer holds them.
  await expect(admin.getByText(backupCodes[0]!)).toHaveCount(0)
})

test('another browser is asked for the app’s code after the password, and can be remembered', async ({
  browser,
}) => {
  const page = await logIn(browser, ADMIN, '/admin/plugins')
  await expect(page).toHaveURL('/admin/login/verify')
  await expect(page.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible()
  // Not signed in yet.
  const peek = await page.context().newPage()
  await peek.goto('/admin/plugins')
  await expect(peek).toHaveURL(/\/admin\/login\?next=/)
  await peek.close()

  await page.getByLabel('Code').fill('000000')
  await page.getByRole('button', { name: 'Verify' }).click()
  await error(page, 'That code isn’t right.')

  // The code that set the app up is used: the app's next one signs in.
  await page.getByLabel('Code').fill(totp(secret, Date.now() + 30_000))
  await page.getByLabel('Don’t ask again on this device for 30 days').check()
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL('/admin/plugins')

  await page.getByRole('button', { name: /^Howdy, / }).click()
  await page.getByRole('button', { name: 'Log Out' }).click()
  await notice(page, 'You are signed out.')
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Log In' }).click()
  // Remembered: no code this time.
  await expect(page).toHaveURL('/admin')
  await page.goto('/admin/profile')
  await expect(page.getByRole('region', { name: 'Two-step sign-in' })).toContainText(
    '1 browser doesn’t ask you for a code.',
  )
  await page.close()
})

test('a backup code signs in once, on the site’s account page, where a phone is then set up', async ({
  browser,
}) => {
  const page = await browser.newPage()
  await page.goto('/account')
  const form = page.getByRole('form', { name: 'Sign in' })
  await form.getByLabel('Email address').fill(ADMIN.email)
  await form.getByLabel('Password').fill(ADMIN.password)
  await form.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/account/verify')
  await page.getByRole('link', { name: 'Use another way: Backup code' }).click()
  await expect(page.getByText('Enter one of your backup codes. Each works once.')).toBeVisible()
  await page.getByLabel('Code').fill(backupCodes[0]!.toUpperCase())
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()

  const section = page.getByRole('region', { name: 'Two-step sign-in' })
  await expect(section).toContainText('You have 9 of 10 left.')
  // WhatsApp is on too, and asks for a number of its own: this is the text message's form.
  const sms = section.getByRole('form', { name: 'Set up Text message' })
  await sms.getByLabel('Mobile number').fill('+39 333 123 4567')
  await sms.getByRole('button', { name: 'Send a code', exact: true }).click()
  textedAt = Date.now()
  await expect(page.getByRole('status')).toHaveText('We sent a code to the number ending in 67.')
  const code = /^(\d{6}) is your My Site code/.exec(await text(PHONE, /is your My Site code/))![1]!
  await section.getByRole('form', { name: 'Confirm Text message' }).getByLabel('Code').fill(code)
  await section.getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByRole('status')).toHaveText(
    'Codes by text message are on: you’ll be sent one when you sign in.',
  )
  await expect(section).toContainText('On: codes go to the number ending in 67.')

  // The used backup code doesn't work again.
  const again = await browser.newPage()
  await again.goto('/account')
  const second = again.getByRole('form', { name: 'Sign in' })
  await second.getByLabel('Email address').fill(ADMIN.email)
  await second.getByLabel('Password').fill(ADMIN.password)
  await second.getByRole('button', { name: 'Sign in' }).click()
  await again.getByRole('link', { name: 'Use another way: Backup code' }).click()
  await again.getByLabel('Code').fill(backupCodes[0]!)
  await again.getByRole('button', { name: 'Verify' }).click()
  await error(again, 'That code isn’t right.')
  await again.close()
  await page.close()

  // They're told a backup code was used.
  await newest<Mail>(
    'e2e-mail',
    (mail) =>
      mail.to.includes(ADMIN.email) && mail.subject.endsWith('A backup code was used to sign in'),
    'an email about the backup code',
  )
})

test('a role that must use a code gets one by email until its people set up their own', async ({
  browser,
}) => {
  await admin.goto('/admin/otp/settings')
  await admin
    .getByRole('group', { name: 'Roles that must use a code' })
    .getByLabel('Editor')
    .check()
  await admin.getByRole('button', { name: 'Save Changes' }).click()
  await notice(admin, 'Settings saved.')

  await admin.goto('/admin/users/new')
  await admin.getByLabel('Email').fill(EDITOR.email)
  await admin.getByLabel('Role').selectOption({ label: 'Editor' })
  await admin.getByLabel('Password').fill(EDITOR.password)
  await admin.getByRole('button', { name: 'Add User' }).click()
  await notice(admin, `Added ${EDITOR.email}.`)
  // Edit User says where this person's codes go.
  await admin.getByRole('link', { name: EDITOR.email }).first().click()
  await expect(
    admin.getByText(/hasn’t set up a way of their own; their role’s codes go to their email/),
  ).toBeVisible()

  const page = await logIn(browser, EDITOR)
  await expect(page).toHaveURL('/admin/login/verify')
  await expect(page.getByText('Enter the 6-digit code we sent to e•••@example.com.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send a new code' })).toBeVisible()
  await page.getByLabel('Code').fill(await emailedCode(EDITOR.email, 'Your sign-in code'))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL('/admin')
  await page.goto('/admin/profile')
  await expect(page.getByRole('region', { name: 'Two-step sign-in' })).toContainText(
    'Until you set up a way of your own, codes are emailed to you.',
  )
  await page.close()
})

test('a form on the site takes a message only from an address its sender proved', async ({
  page,
}) => {
  const email = `vera-${run}@example.com`
  await page.goto('/contact')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Message').fill('Hello there')
  // Without a code, the form's handler refuses.
  await page.getByRole('button', { name: 'Send message' }).click()
  await error(page, 'Confirm your email address with a code first.')

  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Send me a code' }).click()
  await expect(page.getByRole('status')).toHaveText('We sent a code to v•••@example.com.')
  const code = await emailedCode(email, 'Your code')
  await page.getByLabel('Code').fill('000000')
  await page.getByRole('button', { name: 'Check code' }).click()
  await error(page, 'That code isn’t right, or it has run out.')
  await page.getByLabel('Code').fill(code)
  await page.getByRole('button', { name: 'Check code' }).click()
  await expect(page.getByRole('status')).toHaveText('v•••@example.com is confirmed.')
  await expect(page.locator('input[name="otp"]')).toHaveCount(1)

  // A code proves the address it went to: change the address, and it proves nothing.
  await page.getByLabel('Email address').fill(`someone-else-${run}@example.com`)
  await expect(page.locator('input[name="otp"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send me a code' })).toBeVisible()
  await page.getByLabel('Message').fill('Hello there')
  await page.getByRole('button', { name: 'Send message' }).click()
  await error(page, 'Confirm your email address with a code first.')
})

test('a message goes through once its sender’s address is confirmed', async ({ page }) => {
  const email = `walt-${run}@example.com`
  await page.goto('/contact')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Send me a code' }).click()
  await expect(page.getByRole('status')).toHaveText('We sent a code to w•••@example.com.')
  await page.getByLabel('Code').fill(await emailedCode(email, 'Your code'))
  await page.getByLabel('Code').press('Enter')
  await expect(page.getByRole('status')).toHaveText('w•••@example.com is confirmed.')
  await page.getByLabel('Message').fill('Hello there')
  await page.getByRole('button', { name: 'Send message' }).click()
  await notice(page, /Thanks: your message was sent\./)
})

test('a code by text message signs in, from the account page’s other ways', async ({ browser }) => {
  // A number is sent one text a minute; the one that set it up was the last.
  test.setTimeout(150_000)
  const page = await browser.newPage()
  await page.goto('/account')
  const form = page.getByRole('form', { name: 'Sign in' })
  await form.getByLabel('Email address').fill(ADMIN.email)
  await form.getByLabel('Password').fill(ADMIN.password)
  await form.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/account/verify')

  // Asked for too soon, it says to wait, and the app and backup codes still work.
  if (Date.now() - textedAt < 55_000) {
    await page.getByRole('button', { name: 'Use another way: Text message' }).click()
    await error(page, 'Wait a minute before asking for another code.')
  }
  await page.waitForTimeout(Math.max(0, 61_000 - (Date.now() - textedAt)))
  const before = Date.now()
  await page.getByRole('button', { name: 'Use another way: Text message' }).click()
  await expect(page.getByRole('status')).toHaveText('A new code is on its way.')
  await expect(page).toHaveURL(/\/account\/verify\?method=sms/)
  await expect(
    page.getByText('Enter the 6-digit code we sent to the number ending in 67.'),
  ).toBeVisible()
  expect(Date.now() - before).toBeLessThan(10_000)

  // The newest text: the one that set the number up came first.
  const files = (await readdir(join(DATA, 'e2e-sms'))).sort()
  const latest = JSON.parse(await readFile(join(DATA, 'e2e-sms', files.at(-1)!), 'utf8')) as {
    to: string
    text: string
  }
  expect(latest.to).toBe(PHONE)
  await page.getByLabel('Code').fill(/^(\d{6})/.exec(latest.text)![1]!)
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  await page.close()
})

test('removing a way asks for the password again', async () => {
  await admin.goto('/admin/profile')
  const section = admin.getByRole('region', { name: 'Two-step sign-in' })
  const remove = section.getByRole('form', { name: 'Remove Authenticator app' })
  await section
    .locator('.otp-way', { hasText: 'Authenticator app' })
    .getByText('Remove')
    .first()
    .click()
  await remove.getByLabel('Your password').fill('not my password')
  await remove.getByRole('button', { name: 'Remove Authenticator app' }).click()
  await error(admin, 'Your password is incorrect.')

  await section
    .locator('.otp-way', { hasText: 'Authenticator app' })
    .getByText('Remove')
    .first()
    .click()
  await remove.getByLabel('Your password').fill(ADMIN.password)
  await remove.getByRole('button', { name: 'Remove Authenticator app' }).click()
  await notice(admin, 'Your authenticator app was removed.')
  // The phone remains, so two-step sign-in is still on.
  await expect(section).toContainText('On: after your password, you’re asked for a code.')
  await expect(section.getByRole('button', { name: 'Set up an app' })).toBeVisible()
})
