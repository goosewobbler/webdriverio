import logger from '@wdio/logger'
import type {
    DisplayDaemon,
    DisplayDaemonOptions,
    DisplayServer,
    DisplayServerInstallOptions,
} from './types.js'
import { commandExists, installViaPackageManager, resolveDaemonDimensions } from './utils.js'
import { DISPLAY_FD, runDaemon } from './daemonProcess.js'

export class XvfbDisplayServer implements DisplayServer {
    readonly name = 'xvfb' as const
    private log = logger('@wdio/display-server:xvfb')

    async isAvailable(): Promise<boolean> {
        // Only Xvfb is required: the daemon spawns `Xvfb` directly, not the
        // `xvfb-run` wrapper, so probing xvfb-run would wrongly skip the daemon
        // on systems that ship Xvfb without it.
        if (await commandExists('Xvfb')) {
            this.log.info('Xvfb found in PATH')
            return true
        }
        this.log.debug('Xvfb not found')
        return false
    }

    async install(options?: DisplayServerInstallOptions): Promise<boolean> {
        return installViaPackageManager({
            name: 'Xvfb',
            packageCommands: {
                apt: 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb',
                dnf: 'dnf -y makecache && dnf -y install xorg-x11-server-Xvfb',
                zypper: 'zypper --non-interactive refresh && zypper --non-interactive install -y xvfb-run',
                // -Syu, not -Sy: Arch doesn't support partial upgrades.
                pacman: 'pacman -Syu --noconfirm xorg-server-xvfb',
                apk: 'apk update && apk add --no-cache xvfb-run',
                // xbps refuses to install anything while xbps itself is outdated.
                xbps: 'xbps-install -Suy xbps && xbps-install -y xvfb-run',
            },
            log: this.log,
            options,
        })
    }

    getChromeFlags(): string[] {
        // Forces the X11 ozone backend so a Wayland-host caller using
        // `displayServer: 'xvfb'` doesn't have Chromium try the host's
        // compositor instead of our Xvfb.
        return ['--ozone-platform=x11']
    }

    async startDaemon(options?: DisplayDaemonOptions): Promise<DisplayDaemon> {
        const { width, height, depth } = resolveDaemonDimensions(options)

        this.log.info(`Starting Xvfb daemon (${width}x${height}x${depth})`)

        return runDaemon({
            command: 'Xvfb',
            // Xvfb claims the first free display itself and reports it on DISPLAY_FD once listening.
            args: ['-displayfd', String(DISPLAY_FD), '-screen', '0', `${width}x${height}x${depth}`, '-nolisten', 'tcp'],
            ready: {
                displayFd: true,
                env: (display) => ({
                    DISPLAY: `:${display}`,
                    // Pin GTK & Electron to X11 so a Wayland host's inherited GDK_BACKEND=wayland,x11 doesn't send them to Wayland.
                    GDK_BACKEND: 'x11',
                    ELECTRON_OZONE_PLATFORM_HINT: 'x11',
                }),
            },
            label: 'Xvfb',
            log: this.log,
        })
    }
}
