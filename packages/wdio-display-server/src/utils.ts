import { exec, execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type logger from '@wdio/logger'
import type { DisplayDaemonOptions, DisplayServerInstallOptions } from './types.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// Package installs pull toolchains/mirrors and are slow; give them 4 minutes.
const INSTALL_TIMEOUT_MS = 240_000

/** True if `command` is an executable file in a PATH directory. */
export async function commandExists(command: string): Promise<boolean> {
    // Searched as spawn (libuv) searches: an unset PATH means /usr/bin:/bin, an empty entry the working directory.
    const dirs = process.env.PATH === undefined ? ['/usr/bin', '/bin'] : process.env.PATH.split(path.delimiter)
    for (const dir of dirs) {
        try {
            // Not path.join, which collapses `..` before symlinks resolve, unlike execvp.
            const stats = await stat(dir ? `${dir}/${command}` : command)
            if (stats.isFile() && (stats.mode & 0o111) !== 0) {
                return true
            }
        } catch { /* not in this directory */ }
    }
    return false
}

/** Daemon screen geometry with the shared defaults applied (depth is Xvfb-only). */
export function resolveDaemonDimensions(options?: DisplayDaemonOptions): { width: number, height: number, depth: number } {
    return {
        width: options?.width ?? 1920,
        height: options?.height ?? 1080,
        depth: options?.depth ?? 24,
    }
}

/**
 * Poll for the socket file at `socketPath` to appear, up to `timeoutMs`.
 *
 * @param label - name used in the timeout error message (e.g. "Wayland socket").
 * @param signal - stops polling early; callers abort it once the exit/socket race settles.
 */
export async function waitForSocket(socketPath: string, timeoutMs: number, label = 'socket', signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            return
        }
        try {
            await access(socketPath)
            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }
    throw new Error(`Timed out waiting for ${label} at ${socketPath}`)
}

export async function detectPackageManager(): Promise<string> {
    const packageManagers = [
        { command: 'apt-get', name: 'apt' },
        { command: 'dnf', name: 'dnf' },
        { command: 'zypper', name: 'zypper' },
        { command: 'pacman', name: 'pacman' },
        { command: 'apk', name: 'apk' },
        { command: 'xbps-install', name: 'xbps' },
    ]

    for (const { command, name } of packageManagers) {
        if (await commandExists(command)) {
            return name
        }
    }

    return 'unknown'
}

/**
 * Install a display server binary via the system package manager. Shared by the
 * Wayland and Xvfb backends, which supply only their own command table and name.
 */
export async function installViaPackageManager({
    name,
    packageCommands,
    log,
    options,
}: {
    name: string
    packageCommands: Record<string, string>
    log: ReturnType<typeof logger>
    options?: DisplayServerInstallOptions
}): Promise<boolean> {
    log.info(`Attempting to install ${name}...`)

    if (options?.command) {
        try {
            if (Array.isArray(options.command)) {
                // Array form = argv vector, no shell interpolation.
                const [bin, ...args] = options.command
                if (!bin) {
                    log.error(`Failed to install ${name}: options.command array is empty`)
                    return false
                }
                await execFileAsync(bin, args, { timeout: INSTALL_TIMEOUT_MS })
            } else {
                // String form = caller wants a shell.
                await execAsync(options.command, { timeout: INSTALL_TIMEOUT_MS })
            }
            log.info(`${name} installed successfully using custom command`)
            return true
        } catch (error) {
            log.error(`Failed to install ${name} with custom command:`, error)
            return false
        }
    }

    const packageManager = await detectPackageManager()

    if (!packageCommands[packageManager]) {
        log.error(`Unsupported package manager: ${packageManager}`)
        return false
    }

    const command = packageCommands[packageManager]
    let sudoWrap = false

    if (options?.mode === 'sudo') {
        if (process.getuid && process.getuid() !== 0) {
            if (await commandExists('sudo')) {
                sudoWrap = true
            } else {
                log.warn('sudo not available, attempting install without sudo')
            }
        }
    } else if (options?.mode === 'root') {
        if (process.getuid && process.getuid() !== 0) {
            log.error('Not running as root and autoInstallMode is "root"')
            return false
        }
    }

    try {
        // sudo path: pass `command` as one argv element to sh -c, so shell
        // metacharacters stay inside the inner shell.
        await (sudoWrap
            ? execFileAsync('sudo', ['-n', 'sh', '-c', command], { timeout: INSTALL_TIMEOUT_MS })
            : execAsync(command, { timeout: INSTALL_TIMEOUT_MS }))
        log.info(`${name} installed successfully`)
        return true
    } catch (error) {
        log.error(`Failed to install ${name}:`, error)
        return false
    }
}
