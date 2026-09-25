import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import logger from '@wdio/logger'
import type {
    DisplayDaemon,
    DisplayDaemonOptions,
    DisplayServer,
    DisplayServerInstallOptions,
} from './types.js'
import { commandExists, installViaPackageManager, resolveDaemonDimensions } from './utils.js'
import { runDaemon } from './daemonProcess.js'

const execFileAsync = promisify(execFile)

// One source of truth: getChromeFlags() and DisplayServerManager's
// externally-set-WAYLAND_DISPLAY fallback both use these and must not drift.
export const WAYLAND_CHROME_FLAGS: string[] = ['--ozone-platform=wayland']

// Exported so a test can run the dnf fallback through a real shell.
export const WESTON_INSTALL_COMMANDS: Record<string, string> = {
    apt: 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y weston',
    // EL 10 has no Xvfb and ships Weston only in EPEL, which needs CRB. Older EL uses its own Xvfb instead.
    // crb enable needs dnf-plugins-core, which epel-release only pulls in as a weak dependency.
    dnf: 'dnf -y makecache && (dnf -y install weston || ([ "$(rpm -E "%{?rhel}")" -ge 10 ] 2>/dev/null && dnf -y install epel-release dnf-plugins-core && crb enable && dnf -y install weston))',
    zypper: 'zypper --non-interactive refresh && zypper --non-interactive install -y weston',
    // -Syu, not -Sy: Arch doesn't support partial upgrades, which can leave Weston needing a newer glibc.
    pacman: 'pacman -Syu --noconfirm weston',
    // Alpine splits the headless backend and the default shell into subpackages.
    apk: 'apk update && apk add --no-cache weston weston-backend-headless weston-shell-desktop',
    // xbps refuses to install anything while xbps itself is outdated.
    xbps: 'xbps-install -Suy xbps && xbps-install -y weston',
}

export class WaylandDisplayServer implements DisplayServer {
    readonly name = 'wayland' as const
    private log = logger('@wdio/display-server:wayland')
    private majorVersion?: number

    async isAvailable(): Promise<boolean> {
        if (await commandExists('weston')) {
            this.log.info('Weston compositor found in PATH')
            return true
        }
        this.log.debug('Weston compositor not found')
        return false
    }

    async install(options?: DisplayServerInstallOptions): Promise<boolean> {
        return installViaPackageManager({
            name: 'Weston',
            packageCommands: WESTON_INSTALL_COMMANDS,
            log: this.log,
            options,
        })
    }

    getChromeFlags(): string[] {
        return [...WAYLAND_CHROME_FLAGS]
    }

    /** Major version from `weston --version` ("weston 13.0.1"); unreadable counts as current. */
    private async westonMajor(): Promise<number> {
        if (this.majorVersion === undefined) {
            try {
                const { stdout } = await execFileAsync('weston', ['--version'], { timeout: 5000 })
                const major = Number(/weston\s+(\d+)/.exec(stdout)?.[1])
                this.majorVersion = Number.isFinite(major) ? major : Infinity
            } catch {
                this.majorVersion = Infinity
            }
        }
        return this.majorVersion
    }

    async startDaemon(options?: DisplayDaemonOptions): Promise<DisplayDaemon> {
        const { width, height } = resolveDaemonDimensions(options)
        // Weston 12 renamed the backend and renderer switches. Debian 12, the base of
        // the default node:22 image, still ships Weston 10, so we support the legacy switches.
        const legacy = (await this.westonMajor()) < 12

        // A fresh 0700 directory per daemon, so a leftover from a killed run is never reused.
        // Rooted at /tmp, not TMPDIR, to keep the socket path under the 107-byte Unix limit.
        const runtimeDir = await mkdtemp('/tmp/wdio-wayland-')
        const socketName = 'wayland-0'
        const socketPath = path.join(runtimeDir, socketName)

        this.log.info(`Starting Weston daemon on ${socketName} (${width}x${height}) in ${runtimeDir}`)

        return runDaemon({
            command: 'weston',
            args: [
                legacy ? '--backend=headless-backend.so' : '--backend=headless',
                `--width=${width}`,
                `--height=${height}`,
                legacy ? '--use-pixman' : '--renderer=pixman', // software rendering for GPU-less CI
                '--idle-time=0', // Weston otherwise sleeps after 300s without input
                '--no-config', // keeps a user's weston.ini out of the test compositor
                `--socket=${socketName}`,
            ],
            ready: {
                socketPath,
                socketLabel: 'Wayland socket',
                env: {
                    WAYLAND_DISPLAY: socketName,
                    XDG_RUNTIME_DIR: runtimeDir,
                    // Pin GTK to our weston compositor so an inherited GDK_BACKEND
                    // doesn't send GTK to a missing X11.
                    GDK_BACKEND: 'wayland',
                    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
                },
            },
            spawnEnv: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
            label: 'Weston',
            log: this.log,
            cleanup: () => rm(runtimeDir, { recursive: true, force: true }).catch(() => {}),
            cleanupSync: () => {
                try {
                    rmSync(runtimeDir, { recursive: true, force: true })
                } catch { /* best-effort */ }
            },
        })
    }

}
