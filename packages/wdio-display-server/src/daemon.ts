import logger from '@wdio/logger'

import { DisplayServerManager, optionsFromConfig } from './DisplayServerManager.js'
import type { DisplayDaemonOptions } from './types.js'

const log = logger('@wdio/display-server:daemon')

/** Stopping reverses both the daemon process and the env mutation on `process.env`. */
export interface RunningDaemon {
    stop(): Promise<void>
}

function daemonOptionsFromConfig(config: WebdriverIO.Config): DisplayDaemonOptions {
    return {
        width: config.displayServerWidth,
        height: config.displayServerHeight,
        depth: config.displayServerDepth,
    }
}

/**
 * Start a persistent display-server daemon (Wayland/Weston or Xvfb) and publish
 * its env onto `process.env`, so any child process — including drivers spawned
 * from a service's `onPrepare` — inherits the display.
 *
 * Returns `null` (no-op) when:
 *  - not Linux,
 *  - `displayServerEnabled` is false,
 *  - `shouldRun()` says no,
 *  - `DISPLAY` / `WAYLAND_DISPLAY` is already on `process.env`, or
 *  - no display server could be started.
 *
 * Intended to be called from a `Runner`'s `initialize()`, which runs before
 * any service `onPrepare`.
 *
 * @param manager Pass the manager that will later inject flags, so it knows the
 *   active server. Defaults to a fresh one.
 */
export async function startDisplayDaemonFromConfig(
    config: WebdriverIO.Config,
    manager: DisplayServerManager = new DisplayServerManager(optionsFromConfig(config)),
): Promise<RunningDaemon | null> {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
        log.info('DISPLAY/WAYLAND_DISPLAY already set; daemon not needed')
        return null
    }

    if (!manager.shouldRun()) {
        log.info('Display server not required on this platform/config')
        return null
    }

    const daemon = await manager.startDaemon(daemonOptionsFromConfig(config))
    if (!daemon) {
        log.warn('No display server could be started; continuing without a virtual display')
        return null
    }

    // Capture pre-existing values so stop() can restore them.
    const envKeys = Object.keys(daemon.env)
    const savedEnv: Record<string, string> = {}
    for (const key of envKeys) {
        if (key in process.env) {
            savedEnv[key] = process.env[key] as string
        }
    }
    Object.assign(process.env, daemon.env)
    log.info(`Daemon ready (${manager.getDisplayServer()?.name}); env: ${JSON.stringify(daemon.env)}`)

    // Not called on signal exits; runDaemon kills the daemon on process exit instead.
    let stopPromise: Promise<void> | null = null
    const stop = (): Promise<void> => {
        stopPromise ??= (async () => {
            try {
                await daemon.stop()
            } finally {
                for (const key of envKeys) {
                    if (key in savedEnv) {
                        process.env[key] = savedEnv[key]
                    } else {
                        delete process.env[key]
                    }
                }
            }
        })()
        return stopPromise
    }

    return { stop }
}
