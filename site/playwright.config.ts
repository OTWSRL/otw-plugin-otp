import { defineConfig, devices } from '@playwright/test'

const PORT = 3495
/** The stand-in SMS service the plugin's HTTP provider posts to (e2e/fake-sms.mjs). */
const SMS_PORT = 3496
const SMS_TOKEN = 'e2e-sms-token'

export default defineConfig({
  testDir: './e2e',
  // One server on one embedded database, set up by the first test.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/fake-sms.mjs',
      url: `http://127.0.0.1:${SMS_PORT}/health`,
      reuseExistingServer: false,
      env: {
        FAKE_SMS_PORT: String(SMS_PORT),
        FAKE_SMS_DIR: '.data/e2e-sms',
        OTP_SMS_TOKEN: SMS_TOKEN,
      },
    },
    {
      // A fresh database and mail folder each run, so the first visit sets the site up.
      command: `node -e "for (const dir of ['.data/e2e', '.data/e2e-mail']) fs.rmSync(dir, { recursive: true, force: true })" && pnpm build && pnpm start --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        CMS_DATA_DIR: '.data/e2e',
        DATABASE_URL: '',
        MAIL_FILE_DIR: '.data/e2e-mail',
        // Text messages go to the stand-in service; its secret comes from the environment.
        OTP_SMS_URL: `http://127.0.0.1:${SMS_PORT}/sms`,
        OTP_SMS_TOKEN: SMS_TOKEN,
        OTP_SECRET_KEY: 'an e2e key of at least thirty-two characters',
      },
    },
  ],
})
