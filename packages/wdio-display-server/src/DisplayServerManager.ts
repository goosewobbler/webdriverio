import os from 'node:os'
import logger from '@wdio/logger'
import { isChrome, isEdge } from '@wdio/utils'
import type { Capabilities } from '@wdio/types'
import type { DisplayDaemon, DisplayDaemonOptions, DisplayServer, DisplayServerOptions } from './types.js'
import { WaylandDisplayServer, WAYLAND_CHROME_FLAGS } from './WaylandDisplayServer.js'
import { XvfbDisplayServer } from './XvfbDisplayServer.js'

// A worker's capabilities come in three shapes: single ({ browserName }), vendor-keyed
// ({ 'goog:chromeOptions' }), and multiremote ({ browserA: {...} }).

type CapsRoot = WebdriverIO.Capabilities | Record<string, WebdriverIO.Capabilities | { capabilities: WebdriverIO.Capabilities }>

// Capability entries can be malformed (a bare string, an unset env var as a
// multiremote value); only plain objects are worth inspecting or mutating.
function isCapabilityObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSingleCapability(caps: CapsRoot): caps is WebdriverIO.Capabilities {
    return Boolean(
        (caps as WebdriverIO.Capabilities)['goog:chromeOptions'] ||
        (caps as WebdriverIO.Capabilities)['ms:edgeOptions'] ||
        (caps as WebdriverIO.Capabilities)['moz:firefoxOptions'] ||
        'browserName' in caps
    )
}

function extractCapabilitiesFromBrowserConfig(
    browserConfig: { capabilities: WebdriverIO.Capabilities } | WebdriverIO.Capabilities
): WebdriverIO.Capabilities {
    if (browserConfig && typeof browserConfig === 'object' && 'capabilities' in browserConfig && browserConfig.capabilities) {
        return browserConfig.capabilities
    }
    return browserConfig as WebdriverIO.Capabilities
}

function forEachBrowserCapability(root: unknown, visit: (cap: WebdriverIO.Capabilities) => void): void {
    if (!isCapabilityObject(root)) {
        return
    }
    const caps = root as CapsRoot
    if (isSingleCapability(caps)) {
        visit(caps)
        return
    }
    // Multiremote map: { browserA: { capabilities } | capabilities, ... }
    for (const browserConfig of Object.values(caps)) {
        const cap = extractCapabilitiesFromBrowserConfig(browserConfig)
        if (isCapabilityObject(cap)) {
            visit(cap)
        }
    }
}

export function optionsFromConfig(config: WebdriverIO.Config): DisplayServerOptions {
    return {
        enabled: config.displayServerEnabled,
        displayServer: config.displayServer,
        autoInstall: config.displayServerAutoInstall,
        autoInstallMode: config.displayServerAutoInstallMode,
        autoInstallCommand: config.displayServerAutoInstallCommand,
    }
}

export class DisplayServerManager {
    #enabled: boolean
    #displayServerPreference: 'auto' | 'wayland' | 'xvfb'
    #autoInstall: boolean
    #autoInstallMode: 'root' | 'sudo'
    #autoInstallCommand?: string | string[]
    #force: boolean
    #log: ReturnType<typeof logger>
    #displayServer: DisplayServer | null = null
    #wayland = new WaylandDisplayServer()
    #xvfb = new XvfbDisplayServer()

    constructor(options: DisplayServerOptions = {}) {
        this.#enabled = options.enabled ?? true
        this.#displayServerPreference = options.displayServer ?? 'auto'
        this.#autoInstall = options.autoInstall ?? false
        this.#autoInstallMode = options.autoInstallMode ?? 'sudo'
        this.#autoInstallCommand = options.autoInstallCommand
        this.#force = options.force ?? false
        this.#log = logger('@wdio/display-server')
    }

    shouldRun(): boolean {
        if (!this.#enabled) {
            return false
        }
        if (this.#force) {
            return true
        }

        if (os.platform() !== 'linux') {
            return false
        }

        // Once a server is active, workers must use it regardless of what process.env now shows.
        if (this.#displayServer) {
            return true
        }

        return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    }

    async init(): Promise<boolean> {
        this.#log.info('DisplayServerManager.init() called')

        // Idempotent: a second init() must not re-select and overwrite
        // #displayServer, which may already back a running daemon.
        if (this.#displayServer) {
            return true
        }

        if (!this.shouldRun()) {
            this.#log.info('Display server not needed on current platform')
            return false
        }

        for await (const displayServer of this.#candidates()) {
            this.#displayServer = displayServer
            this.#log.info(`${displayServer.name} display server is ready for use`)
            return true
        }
        this.#log.warn('No display server available; continuing without virtual display')
        return false
    }

    /**
     * Start the first candidate that comes up and make it the active server, so
     * injected flags match what is running. Null when none starts.
     */
    async startDaemon(options?: DisplayDaemonOptions): Promise<DisplayDaemon | null> {
        if (!this.shouldRun()) {
            return null
        }
        for await (const displayServer of this.#candidates()) {
            try {
                const daemon = await displayServer.startDaemon(options)
                this.#displayServer = displayServer
                return daemon
            } catch (error) {
                this.#log.warn(`${displayServer.name} failed to start: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        this.#displayServer = null
        return null
    }

    // Yielded lazily, so a server that starts means nothing later is probed or installed.
    // Installed servers come first, so an existing Xvfb is used before Weston is installed.
    async *#candidates(): AsyncGenerator<DisplayServer> {
        const all = [this.#wayland, this.#xvfb]
        const preferred = all.filter((displayServer) => displayServer.name === this.#displayServerPreference)
        const order = preferred.length > 0 ? preferred : all

        const missing: DisplayServer[] = []
        for (const displayServer of order) {
            if (await displayServer.isAvailable()) {
                yield displayServer
            } else {
                missing.push(displayServer)
            }
        }
        for (const displayServer of missing) {
            if (!this.#autoInstall) {
                this.#log.warn(`${displayServer.name} not found. To enable auto-install, set 'displayServerAutoInstall: true' in your WDIO config.`)
                continue
            }
            // Probe before and after: a custom install command is shared by both servers,
            // so an earlier install may have provided this one, or provided the other instead.
            if (!await displayServer.isAvailable()) {
                this.#log.info(`Auto-installing ${displayServer.name}...`)
                if (!await displayServer.install({ mode: this.#autoInstallMode, command: this.#autoInstallCommand })) {
                    continue
                }
                if (!await displayServer.isAvailable()) {
                    this.#log.warn(`${displayServer.name} still not found after installing`)
                    continue
                }
            }
            yield displayServer
        }
    }

    #injectDisplayServerFlags(
        capabilities: Capabilities.ResolvedTestrunnerCapabilities,
        flags: string[],
    ): void {
        if (flags.length === 0) {
            return
        }
        forEachBrowserCapability(capabilities, (cap) => this.#addFlagsToCapability(cap, flags))
    }

    #addFlagsToCapability(caps: WebdriverIO.Capabilities, flags: string[]): void {
        let chromeOptions = caps['goog:chromeOptions'] || (caps as Record<string, unknown>).chromeOptions as { args?: string[] }
        let edgeOptions = caps['ms:edgeOptions'] || (caps as Record<string, unknown>).edgeOptions as { args?: string[] }
        const electronOptions = (caps as Record<string, unknown>)['wdio:electronServiceOptions'] as { appArgs?: string[] } | undefined

        // Create options objects for bare caps like { browserName: 'chrome' }
        if (!chromeOptions && isChrome(caps.browserName)) {
            caps['goog:chromeOptions'] = { args: [] }
            chromeOptions = caps['goog:chromeOptions']
        }
        if (!edgeOptions && isEdge(caps.browserName)) {
            caps['ms:edgeOptions'] = { args: [] }
            edgeOptions = caps['ms:edgeOptions']
        }

        this.#applyFlags(chromeOptions, 'args', flags, 'Chrome capabilities')
        this.#applyFlags(edgeOptions, 'args', flags, 'Edge capabilities')
        // Electron needs the CLI --ozone-platform in appArgs; the env hint
        // ELECTRON_OZONE_PLATFORM_HINT isn't authoritative enough on Wayland hosts.
        this.#applyFlags(electronOptions, 'appArgs', flags, 'Electron appArgs')
    }

    // Add the ozone flags to one options bag, de-duplicated by the --ozone-platform=
    // token so re-injection or a user's own flag doesn't double up.
    #applyFlags(
        options: { args?: string[] } | { appArgs?: string[] } | undefined,
        key: 'args' | 'appArgs',
        flags: string[],
        label: string,
    ): void {
        if (!options) {
            return
        }
        const opts = options as Record<'args' | 'appArgs', string[] | undefined>
        opts[key] = opts[key] || []
        const hasOzoneFlag = opts[key]!.some(arg => typeof arg === 'string' && arg.startsWith('--ozone-platform='))
        if (!hasOzoneFlag) {
            opts[key]!.push(...flags)
            this.#log.info(`Added display-server flags to ${label}: ${flags.join(' ')}`)
        }
    }

    getDisplayServer(): DisplayServer | null {
        return this.#displayServer
    }

    // Without a daemon, an external WAYLAND_DISPLAY (and no DISPLAY) still needs
    // the wayland ozone flag so Chrome doesn't fall back to a missing X11 server.
    injectDisplayFlags(capabilities: Capabilities.ResolvedTestrunnerCapabilities): void {
        if (!capabilities || !this.#enabled) {
            return
        }
        if (this.#displayServer) {
            this.#injectDisplayServerFlags(capabilities, this.#displayServer.getChromeFlags())
            return
        }
        if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
            this.#injectDisplayServerFlags(capabilities, [...WAYLAND_CHROME_FLAGS])
        }
    }
}

// Lazy singleton — avoids side-effects (logger init, option parsing) at import time.
// Methods are bound to _defaultInstance so private-field access inside them works.
let _defaultInstance: DisplayServerManager | undefined
export const displayServer: DisplayServerManager = new Proxy({} as DisplayServerManager, {
    get(_, prop) {
        _defaultInstance ??= new DisplayServerManager()
        const value = Reflect.get(_defaultInstance, prop, _defaultInstance)
        return typeof value === 'function' ? (value as Function).bind(_defaultInstance) : value
    }
})
