import { vi, beforeEach, afterEach, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { DisplayDaemon, DisplayDaemonOptions, DisplayServer } from '../src/types.js'
import type { DisplayServerManager } from '../src/DisplayServerManager.js'

/**
 * Minimal stand-in for a spawned child process. Backend tests drive its
 * lifecycle by emitting 'exit'/'error' and asserting on the spied `kill`.
 */
export class FakeProc extends EventEmitter {
    pid: number | undefined = 4242
    killed = false
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    stdio: Array<PassThrough | null> = []
    stderr = new EventEmitter()
    kill = vi.fn((_signal?: NodeJS.Signals) => {
        this.killed = true
        return true
    })
    removeListener = (event: string, listener: (...args: any[]) => void) => {
        super.removeListener(event, listener)
        return this
    }
    // Like Node: 'exit' records the code or signal, and 'close' follows once stdio has drained.
    emit(event: string | symbol, ...args: any[]): boolean {
        if (event === 'exit') {
            this.exitCode = args[0] ?? null
            this.signalCode = args[1] ?? null
            setImmediate(() => super.emit('close', ...args))
        }
        return super.emit(event, ...args)
    }
}

export const exitOnKill = (proc: FakeProc) => {
    proc.kill.mockImplementation((signal?: NodeJS.Signals) => {
        setImmediate(() => proc.emit('exit', null, signal ?? 'SIGTERM'))
        return true
    })
}

/**
 * Wire the spawn mock to return a fresh FakeProc. For the happy path, also make
 * the socket-poll `access` resolve immediately; non-happy tests omit `mockAccess`
 * and set their own access sequence inline.
 */
export const arrangeSpawn = (mockSpawn: Mock, mockAccess?: Mock) => {
    const proc = new FakeProc()
    mockSpawn.mockReturnValue(proc)
    if (mockAccess) {
        mockAccess.mockResolvedValue(undefined)
    }
    return proc
}

/** Fake child that reports `display` on fd 3, as Xvfb -displayfd does. */
export const arrangeDisplayFdSpawn = (mockSpawn: Mock, display: number | string | null = 99) => {
    const proc = new FakeProc()
    const fd3 = new PassThrough()
    proc.stdio = [null, null, null, fd3]
    mockSpawn.mockReturnValue(proc)
    if (display !== null) {
        setImmediate(() => fd3.write(`${display}\n`))
    }
    return proc
}

/** Removes the process 'exit' listeners that daemons started but never stopped leave behind. */
export const trackExitListeners = () => {
    let before: NodeJS.ExitListener[] = []
    beforeEach(() => {
        before = process.listeners('exit')
    })
    afterEach(() => {
        for (const listener of process.listeners('exit')) {
            if (!before.includes(listener)) {
                process.off('exit', listener)
            }
        }
    })
}

// Queue execAsync rejections for the package managers probed before `pm`, then a
// resolution for `pm`, so install()'s detectPackageManager lands deterministically.
export const PM_PROBE_ORDER = ['apt-get', 'dnf', 'zypper', 'pacman', 'apk', 'xbps-install']
export const PM_NAME_TO_CMD: Record<string, string> = {
    apt: 'apt-get', dnf: 'dnf', zypper: 'zypper',
    pacman: 'pacman', apk: 'apk', xbps: 'xbps-install',
}
export const queuePackageManagerDetection = (mockExecAsync: Mock, pm: string) => {
    if (pm === 'unknown') {
        for (let i = 0; i < PM_PROBE_ORDER.length; i++) {
            mockExecAsync.mockRejectedValueOnce(new Error('not found'))
        }
        return
    }
    const target = PM_NAME_TO_CMD[pm]
    const targetIdx = PM_PROBE_ORDER.indexOf(target)
    for (let i = 0; i < targetIdx; i++) {
        mockExecAsync.mockRejectedValueOnce(new Error('not found'))
    }
    mockExecAsync.mockResolvedValueOnce({ stdout: `/usr/bin/${target}`, stderr: '' })
}

export const runAsRoot = () => {
    (process as any).getuid = vi.fn().mockReturnValue(0)
}

export const runAsUser = (uid = 1000) => {
    (process as any).getuid = vi.fn().mockReturnValue(uid)
}

export const makeDaemonHandle = (overrides: Partial<DisplayDaemon> = {}): DisplayDaemon => ({
    env: {},
    stop: vi.fn().mockResolvedValue(undefined),
    stopSync: vi.fn(),
    ...overrides,
} as DisplayDaemon)

export const makeDisplayServer = (overrides: Partial<DisplayServer> = {}): DisplayServer => ({
    name: 'xvfb',
    isAvailable: async () => true,
    install: async () => true,
    getChromeFlags: () => [],
    startDaemon: async () => makeDaemonHandle(),
    ...overrides,
} as DisplayServer)

/** Manager fake that starts `server` once, returning null without one or when it fails, like the real manager. */
export const makeManager = (
    server: DisplayServer | null,
    { shouldRun = true }: { shouldRun?: boolean } = {},
): DisplayServerManager => {
    let active: DisplayServer | null = null
    return {
        shouldRun: () => shouldRun,
        getDisplayServer: () => active,
        injectDisplayFlags: vi.fn(),
        startDaemon: vi.fn(async (options?: DisplayDaemonOptions) => {
            if (!server) {
                return null
            }
            try {
                const daemon = await server.startDaemon(options)
                active = server
                return daemon
            } catch {
                active = null
                return null
            }
        }),
    } as unknown as DisplayServerManager
}
