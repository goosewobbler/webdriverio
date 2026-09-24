import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

import { arrangeDisplayFdSpawn, arrangeSpawn, exitOnKill, trackExitListeners } from './helpers.js'

const mockSpawn = vi.hoisted(() => vi.fn())
const mockWaitForSocket = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
    spawn: mockSpawn,
}))

// runDaemon only consumes waitForSocket from utils; mocking it lets us drive the
// socket-vs-exit race deterministically without touching the fs.
vi.mock('../src/utils.js', () => ({
    waitForSocket: mockWaitForSocket,
}))

const { runDaemon } = await import('../src/daemonProcess.js')

// runDaemon takes `log` as a param, so no @wdio/logger mock is needed.
const makeLog = () =>
    ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never

const startDaemon = (overrides: Partial<Parameters<typeof runDaemon>[0]> = {}) =>
    runDaemon({
        command: 'test-daemon',
        args: ['--headless'],
        ready: { socketPath: '/tmp/test-daemon.sock', socketLabel: 'test socket', env: { TEST_VAR: 'value' } },
        label: 'TestDaemon',
        log: makeLog(),
        ...overrides,
    })

const displayFdReady = () => ({ displayFd: true as const, env: (display: string) => ({ DISPLAY: `:${display}` }) })

const NEVER = () => new Promise<void>(() => {})

describe('runDaemon', () => {
    trackExitListeners()

    beforeEach(() => {
        vi.clearAllMocks()
        mockWaitForSocket.mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    describe('startup', () => {
        it('spawns the command with the pipe-stderr stdio option and returns a handle exposing the passed env', async () => {
            arrangeSpawn(mockSpawn)
            const env = { DISPLAY: ':1' }

            const daemon = await startDaemon({
                command: 'Xvfb',
                args: [':1'],
                ready: { socketPath: '/tmp/test-daemon.sock', socketLabel: 'test socket', env },
            })

            expect(mockSpawn).toHaveBeenCalledWith('Xvfb', [':1'], {
                stdio: ['ignore', 'ignore', 'pipe'],
            })
            expect(daemon.env).toBe(env)
        })

        it('passes spawnEnv to spawn when provided', async () => {
            arrangeSpawn(mockSpawn)
            const spawnEnv = { XDG_RUNTIME_DIR: '/tmp/rt' }

            await startDaemon({ spawnEnv })

            expect(mockSpawn).toHaveBeenCalledWith('test-daemon', ['--headless'], {
                stdio: ['ignore', 'ignore', 'pipe'],
                env: spawnEnv,
            })
        })

        it('rejects with the exit code and signal when the process exits before the socket appears', async () => {
            const proc = arrangeSpawn(mockSpawn)
            mockWaitForSocket.mockReturnValue(NEVER())

            const startPromise = startDaemon()
            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 1, null)

            await expect(startPromise).rejects.toThrow(
                /TestDaemon process exited unexpectedly \(code=1, signal=null\)/
            )
        })

        it('includes the stderr tail in the exit rejection', async () => {
            const proc = arrangeSpawn(mockSpawn)
            mockWaitForSocket.mockReturnValue(NEVER())

            const startPromise = startDaemon()
            await new Promise((r) => setImmediate(r))
            proc.stderr.emit('data', 'boom on stderr')
            proc.emit('exit', 2, 'SIGABRT')

            const err = await startPromise.catch((e: Error) => e)
            expect((err as Error).message).toContain('code=2, signal=SIGABRT')
            expect((err as Error).message).toContain('boom on stderr')
        })

        it('includes stderr that arrives after the exit event', async () => {
            const proc = arrangeSpawn(mockSpawn)
            mockWaitForSocket.mockReturnValue(NEVER())

            const startPromise = startDaemon()
            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 1, null)
            proc.stderr.emit('data', 'Fatal server error')

            await expect(startPromise).rejects.toThrow(/Fatal server error/)
        })

        it('stops the readiness wait before tearing down a failed start', async () => {
            let abortedAtCleanup: boolean | undefined
            const proc = arrangeSpawn(mockSpawn)
            mockWaitForSocket.mockReturnValue(NEVER())

            const startPromise = startDaemon({
                cleanup: () => {
                    abortedAtCleanup = (mockWaitForSocket.mock.calls[0][3] as AbortSignal).aborted
                },
            })
            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 1, null)

            await expect(startPromise).rejects.toThrow()
            expect(abortedAtCleanup).toBe(true)
        })

        it('keeps the startup error when teardown after a failed start rejects', async () => {
            const proc = arrangeSpawn(mockSpawn)
            mockWaitForSocket.mockReturnValue(NEVER())
            const log = makeLog()

            const startPromise = startDaemon({ log, cleanup: () => Promise.reject(new Error('rm EBUSY')) })
            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 1, null)

            await expect(startPromise).rejects.toThrow(/TestDaemon process exited unexpectedly/)
            expect(log['debug']).toHaveBeenCalledWith('TestDaemon teardown after failed start: rm EBUSY')
        })

        it('keeps the spawn error when cleanup after a synchronous spawn throw rejects', async () => {
            mockSpawn.mockImplementationOnce(() => {
                throw new Error('spawn E2BIG')
            })

            const log = makeLog()

            await expect(startDaemon({ log, cleanup: () => Promise.reject(new Error('rm EBUSY')) }))
                .rejects.toThrow('spawn E2BIG')
            expect(log['debug']).toHaveBeenCalledWith('TestDaemon cleanup after failed spawn: rm EBUSY')
        })

        it('runs cleanup when spawn throws synchronously', async () => {
            const cleanup = vi.fn()
            const listeners = process.listenerCount('exit')
            mockSpawn.mockImplementationOnce(() => {
                throw new Error('spawn E2BIG')
            })

            await expect(startDaemon({ cleanup })).rejects.toThrow('spawn E2BIG')
            expect(cleanup).toHaveBeenCalledTimes(1)
            expect(process.listenerCount('exit')).toBe(listeners)
        })

        it('keeps the startup error when killing the child fails during teardown', async () => {
            vi.useFakeTimers()
            const proc = arrangeSpawn(mockSpawn)
            // Node emits 'error' from kill() for errors like EPERM.
            proc.kill.mockImplementation(() => {
                proc.emit('error', new Error('kill EPERM'))
                return false
            })
            mockWaitForSocket.mockRejectedValue(new Error('Timed out waiting for test socket'))

            const startPromise = startDaemon().catch((e: Error) => e)
            await vi.advanceTimersByTimeAsync(2000)

            expect(((await startPromise) as Error).message).toBe('Timed out waiting for test socket')
        })

        it('rejects with the error message when the process errors before the socket appears', async () => {
            const proc = arrangeSpawn(mockSpawn)
            mockWaitForSocket.mockReturnValue(NEVER())

            const startPromise = startDaemon()
            await new Promise((r) => setImmediate(r))
            proc.exitCode = -2 // Node records the errno before emitting a spawn error
            proc.emit('error', new Error('spawn ENOENT'))

            await expect(startPromise).rejects.toThrow(/TestDaemon process error: spawn ENOENT/)
        })

        it('runs cleanup and SIGTERMs a still-running process when startup fails', async () => {
            const cleanup = vi.fn()
            const proc = arrangeSpawn(mockSpawn)
            exitOnKill(proc)
            mockWaitForSocket.mockRejectedValue(new Error('Timed out waiting for test socket'))

            await expect(startDaemon({ cleanup })).rejects.toThrow('Timed out waiting for test socket')
            expect(cleanup).toHaveBeenCalledTimes(1)
            expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
        })
    })

    describe('displayFd readiness', () => {
        it('opens fd 3 as a pipe, reads the display number from it, and derives env from it', async () => {
            arrangeDisplayFdSpawn(mockSpawn, 42)
            const env = vi.fn((display: string) => ({ DISPLAY: `:${display}` }))

            const daemon = await startDaemon({ ready: { displayFd: true, env } })

            expect(mockSpawn).toHaveBeenCalledWith('test-daemon', ['--headless'], {
                stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
            })
            expect(env).toHaveBeenCalledWith('42')
            expect(daemon.env).toEqual({ DISPLAY: ':42' })
            expect(mockWaitForSocket).not.toHaveBeenCalled()
        })

        it('rejects when the process exits before reporting a display', async () => {
            const proc = arrangeDisplayFdSpawn(mockSpawn, null)

            const startPromise = startDaemon({ ready: displayFdReady() })
            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 1, null)

            await expect(startPromise).rejects.toThrow(/TestDaemon process exited unexpectedly/)
        })

        it('SIGTERMs the child and rejects with the stderr tail when no display arrives within the timeout', async () => {
            const proc = arrangeDisplayFdSpawn(mockSpawn, null)
            exitOnKill(proc)

            const startPromise = startDaemon({ ready: displayFdReady(), timeoutMs: 20 })
            await new Promise((r) => setImmediate(r))
            proc.stderr.emit('data', 'mkdir(/tmp/.X11-unix) failed')

            const err = await startPromise.catch((e: Error) => e)
            expect((err as Error).message).toContain('Timed out waiting for TestDaemon to report its display on fd 3')
            expect((err as Error).message).toContain('mkdir(/tmp/.X11-unix) failed')
            expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
        })

        it('rejects when the line on fd 3 is not a display number', async () => {
            exitOnKill(arrangeDisplayFdSpawn(mockSpawn, 'garbage'))

            await expect(startDaemon({ ready: displayFdReady() }))
                .rejects.toThrow(/TestDaemon reported an invalid display number on fd 3: "garbage"/)
        })

        it('reports a stream error on fd 3 as itself, not as a timeout', async () => {
            const proc = arrangeDisplayFdSpawn(mockSpawn, null)
            exitOnKill(proc)

            const startPromise = startDaemon({ ready: displayFdReady() })
            await new Promise((r) => setImmediate(r))
            proc.stdio[3]!.emit('error', new Error('read EIO'))

            await expect(startPromise).rejects.toThrow(/read EIO/)
        })

        it('rejects with the process error when spawn itself failed and left no stdio', async () => {
            const proc = arrangeSpawn(mockSpawn)

            const startPromise = startDaemon({ ready: displayFdReady() })
            await new Promise((r) => setImmediate(r))
            proc.exitCode = -24
            proc.emit('error', new Error('spawn EMFILE'))

            await expect(startPromise).rejects.toThrow(/TestDaemon process error: spawn EMFILE/)
        })

        it('survives a late error on fd 3 after startup', async () => {
            const proc = arrangeDisplayFdSpawn(mockSpawn, 1)

            await startDaemon({ ready: displayFdReady() })

            expect(() => proc.stdio[3]!.emit('error', new Error('read EIO'))).not.toThrow()
        })
    })

    describe('process exit', () => {
        it('SIGKILLs a running daemon that was never stopped', async () => {
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)
            await startDaemon({ cleanupSync })

            process.emit('exit', 0)

            expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
            expect(cleanupSync).toHaveBeenCalledTimes(1)
        })

        it('still SIGKILLs the child if the process exits while stop() is in flight', async () => {
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)
            const daemon = await startDaemon({ cleanupSync })

            const stopPromise = daemon.stop()
            await new Promise((r) => setImmediate(r))
            process.emit('exit', 0)

            expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
            expect(cleanupSync).toHaveBeenCalledTimes(1)

            proc.emit('exit', null, 'SIGKILL')
            await stopPromise
        })

        it('signals nothing if the process exits before a failed spawn reports its error', async () => {
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)
            proc.pid = undefined
            mockWaitForSocket.mockReturnValue(NEVER())

            const startPromise = startDaemon({ cleanupSync })
            process.emit('exit', 0)
            proc.exitCode = -2
            proc.emit('error', new Error('spawn ENOENT'))

            await expect(startPromise).rejects.toThrow(/spawn ENOENT/)
            // The exit listener ran, but had no child to kill.
            expect(cleanupSync).toHaveBeenCalledTimes(1)
            expect(proc.kill).not.toHaveBeenCalled()
        })

        it("keeps its own exit listener when a caller removes daemon.stopSync from 'exit'", async () => {
            const proc = arrangeSpawn(mockSpawn)
            const daemon = await startDaemon()

            process.off('exit', daemon.stopSync)
            process.emit('exit', 0)

            expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
        })

        it('still runs cleanupSync when the kill throws', async () => {
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)
            proc.kill.mockImplementation(() => {
                throw new Error('kill EPERM')
            })
            await startDaemon({ cleanupSync })

            expect(() => process.emit('exit', 0)).not.toThrow()
            expect(cleanupSync).toHaveBeenCalledTimes(1)
        })

        it('does not throw out of the exit listener when cleanupSync throws', async () => {
            arrangeSpawn(mockSpawn)
            await startDaemon({ cleanupSync: () => {
                throw new Error('rmSync EBUSY')
            } })

            expect(() => process.emit('exit', 0)).not.toThrow()
        })

        it('hands back the in-flight stop() and skips its async cleanup after stopSync()', async () => {
            const cleanup = vi.fn()
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)
            const daemon = await startDaemon({ cleanup, cleanupSync })

            const first = daemon.stop()
            daemon.stopSync()
            expect(daemon.stop()).toBe(first)

            proc.emit('exit', null, 'SIGKILL')
            await first
            expect(cleanupSync).toHaveBeenCalledTimes(1)
            expect(cleanup).not.toHaveBeenCalled()
        })

        it('stops listening for process exit even when stop() rejects', async () => {
            const cleanupSync = vi.fn()
            exitOnKill(arrangeSpawn(mockSpawn))
            const daemon = await startDaemon({ cleanup: () => Promise.reject(new Error('rm EBUSY')), cleanupSync })

            await expect(daemon.stop()).rejects.toThrow('rm EBUSY')
            process.emit('exit', 0)

            expect(cleanupSync).not.toHaveBeenCalled()
        })

        it('survives a stderr pipe error', async () => {
            const proc = arrangeSpawn(mockSpawn)
            await startDaemon()

            expect(() => proc.stderr.emit('error', new Error('read EIO'))).not.toThrow()
        })

        it('stops listening for process exit once stopSync() has run', async () => {
            arrangeSpawn(mockSpawn)
            const daemon = await startDaemon()
            const registered = process.listenerCount('exit')

            daemon.stopSync()

            expect(process.listenerCount('exit')).toBe(registered - 1)
        })

        it('SIGKILLs the child if the process exits while startup is still pending', async () => {
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)
            mockWaitForSocket.mockReturnValue(NEVER())

            const startPromise = startDaemon({ cleanupSync })
            await new Promise((r) => setImmediate(r))
            process.emit('exit', 0)

            expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
            expect(cleanupSync).toHaveBeenCalledTimes(1)

            // The child is gone; let the pending start settle.
            proc.emit('exit', null, 'SIGKILL')
            await expect(startPromise).rejects.toThrow()
        })

        it('stops listening for process exit once stop() has completed', async () => {
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)

            const daemon = await startDaemon({ cleanupSync })
            const stopPromise = daemon.stop()
            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 0, null)
            await stopPromise

            process.emit('exit', 0)

            expect(cleanupSync).not.toHaveBeenCalled()
            expect(proc.kill).toHaveBeenCalledTimes(1)
            expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
        })

        it('stops listening for process exit after a failed startup', async () => {
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)
            mockWaitForSocket.mockReturnValue(NEVER())

            const startPromise = startDaemon({ cleanupSync })
            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 1, null)
            await expect(startPromise).rejects.toThrow()

            process.emit('exit', 0)

            expect(cleanupSync).not.toHaveBeenCalled()
        })
    })

    describe('stop()', () => {
        it('sends SIGTERM then escalates to SIGKILL when the process does not exit within 1s', async () => {
            vi.useFakeTimers()
            const proc = arrangeSpawn(mockSpawn)

            const daemon = await startDaemon()

            const stopPromise = daemon.stop()
            await vi.advanceTimersByTimeAsync(1000)

            expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL')

            // SIGKILL fired; the process now dies. terminate() waits for 'exit'
            // after SIGKILL (2s wedge fallback), so stop() only resolves once it fires.
            proc.emit('exit', null, 'SIGKILL')
            await stopPromise
        })

        it('runs cleanup after the process has exited', async () => {
            const cleanup = vi.fn()
            const proc = arrangeSpawn(mockSpawn)

            const daemon = await startDaemon({ cleanup })

            const stopPromise = daemon.stop()
            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 0, null)
            await stopPromise

            expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
            expect(cleanup).toHaveBeenCalledTimes(1)
        })

        it('is memoized and idempotent — a second call is a no-op returning the same promise', async () => {
            const proc = arrangeSpawn(mockSpawn)

            const daemon = await startDaemon()

            const p1 = daemon.stop()
            const p2 = daemon.stop()
            expect(p2).toBe(p1)

            await new Promise((r) => setImmediate(r))
            proc.emit('exit', 0, null)
            await p1

            expect(proc.kill).toHaveBeenCalledTimes(1)
            expect(proc.kill).toHaveBeenCalledWith('SIGTERM')

            proc.kill.mockClear()
            await daemon.stop()
            expect(proc.kill).not.toHaveBeenCalled()
        })
    })

    describe('stopSync()', () => {
        it('SIGKILLs synchronously and runs cleanupSync', async () => {
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)

            const daemon = await startDaemon({ cleanupSync })

            daemon.stopSync()

            expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
            expect(cleanupSync).toHaveBeenCalledTimes(1)
        })

        it('is idempotent across itself and after stop()', async () => {
            const cleanup = vi.fn()
            const cleanupSync = vi.fn()
            const proc = arrangeSpawn(mockSpawn)

            const daemon = await startDaemon({ cleanup, cleanupSync })

            daemon.stopSync()
            daemon.stopSync()
            await daemon.stop()

            // Only the first stopSync() acts; the second and the subsequent stop()
            // short-circuit, so the async cleanup never runs.
            expect(proc.kill).toHaveBeenCalledTimes(1)
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
            expect(cleanupSync).toHaveBeenCalledTimes(1)
            expect(cleanup).not.toHaveBeenCalled()
        })
    })
})
