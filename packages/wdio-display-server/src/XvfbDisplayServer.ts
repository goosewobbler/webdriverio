import { readFile } from 'node:fs/promises'
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
    private isCentOS10 = false

    async isAvailable(): Promise<boolean> {
        if (await this.checkIsCentOS10()) {
            this.log.info('CentOS Stream 10 detected - Xvfb unavailable, skipping')
            this.isCentOS10 = true
            return false
        }

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

    private async checkIsCentOS10(): Promise<boolean> {
        try {
            const content = await readFile('/etc/os-release', 'utf-8')
            return content.includes('CentOS Stream') && content.includes('VERSION_ID="10"')
        } catch {
            return false
        }
    }

    async install(options?: DisplayServerInstallOptions): Promise<boolean> {
        // Xvfb has no maintained package on CentOS Stream 10; bail before
        // probing the package manager.
        if (this.isCentOS10) {
            this.log.info('Skipping Xvfb installation on CentOS Stream 10 - not available')
            return false
        }

        return installViaPackageManager({
            name: 'Xvfb',
            packageCommands: {
                apt: 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb',
                dnf: 'dnf -y makecache && dnf -y install xorg-x11-server-Xvfb xorg-x11-server-utils',
                yum: 'yum -y makecache && yum -y install xorg-x11-server-Xvfb xorg-x11-server-utils',
                zypper: 'zypper --non-interactive refresh && zypper --non-interactive install -y xvfb-run',
                pacman: 'pacman -Sy --noconfirm xorg-server-xvfb',
                apk: 'apk update && apk add --no-cache xvfb-run',
                xbps: 'xbps-install -Sy xvfb-run',
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
