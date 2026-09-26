import url from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

/**
 * Exercises the full LocalRunner ↔ startDisplayDaemonFromConfig integration:
 * the runner starts a real Xvfb/Weston daemon in `initialize()` and publishes its
 * env on `process.env` (with an existing Wayland display it only sets the session
 * vars), then forks a wdio worker that launches Chrome *without* --headless, so
 * the display is required for the session to succeed.
 *
 * Distinct from wdio.conf.ts which runs the existing/base specs with
 * `displayServerEnabled: false` (those tests drive DisplayServerManager directly
 * and use a --headless Chrome that doesn't need the display).
 */
export const config: WebdriverIO.Config = {
    specs: [
        path.join(__dirname, 'runner.e2e.ts')
    ],

    /**
     * No --headless: the worker actually needs the display the runner provisions.
     */
    capabilities: [{
        browserName: 'chrome',
        'goog:chromeOptions': {
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage'
            ],
            ...(process.env.CHROME_BIN && { binary: process.env.CHROME_BIN })
        },
        // See wdio.conf.ts — same musl/glibc rationale.
        ...(process.env.CHROMEDRIVER_PATH && {
            'wdio:chromedriverOptions': { binary: process.env.CHROMEDRIVER_PATH }
        })
    }],

    logLevel: 'info',
    framework: 'mocha',
    outputDir: path.join(__dirname, 'logs'),

    runner: 'local',

    // Let the local runner start Xvfb/Weston when the container has no display.
    displayServerEnabled: true,
    displayServer: 'auto',

    reporters: ['spec'],

    mochaOpts: {
        ui: 'bdd',
        timeout: 120000
    },
}
