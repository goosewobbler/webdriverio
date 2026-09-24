import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type logger from '@wdio/logger'
import { waitForSocket } from './utils.js'
import type { DisplayDaemon } from './types.js'

/** The descriptor a daemon reports its display number on. */
export const DISPLAY_FD = 3

type Readiness =
    /** Poll for a socket file to appear. */
    | { socketPath: string, socketLabel: string, env: Record<string, string> }
    /** The daemon writes its display number to DISPLAY_FD once it is listening. */
    | { displayFd: true, env: (display: string) => Record<string, string> }

interface RunDaemonOptions {
    command: string
    args: string[]
    /** Carries the env exposed on the returned handle for downstream children. */
    ready: Readiness
    log: ReturnType<typeof logger>
    label: string
    /** For the spawned process; defaults to inheriting process.env. */
    spawnEnv?: NodeJS.ProcessEnv
    timeoutMs?: number
    /** Runs after the process exits, in stop() and on startup failure. */
    cleanup?: () => void | Promise<void>
    /** Best-effort synchronous teardown for Node's 'exit' handler. */
    cleanupSync?: () => void
}

/** First line the daemon writes to `stream`, which must be a display number. */
async function readDisplayNumber(
    stream: Readable, timeoutMs: number, label: string, signal: AbortSignal, stderrTail: () => string,
): Promise<string> {
    const lines = createInterface({ input: stream })
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
        const [line] = await once(lines, 'line', { signal: AbortSignal.any([signal, timeout]) })
        const display = String(line).trim()
        if (!/^\d+$/.test(display)) {
            throw new Error(`${label} reported an invalid display number on fd ${DISPLAY_FD}: ${JSON.stringify(display)}`)
        }
        return display
    } catch (err) {
        if (timeout.aborted) {
            const tail = stderrTail()
            throw new Error(`Timed out waiting for ${label} to report its display on fd ${DISPLAY_FD}${tail ? `\n${tail}` : ''}`)
        }
        throw err
    } finally {
        lines.close()
    }
}

/**
 * Shared daemon lifecycle for the Wayland and Xvfb backends, which differ only
 * in command, readiness signal, exposed env, and per-backend cleanup.
 */
export async function runDaemon({
    command, args, ready, log, label, spawnEnv, timeoutMs = 10_000, cleanup, cleanupSync,
}: RunDaemonOptions): Promise<DisplayDaemon> {
    const displayFd = 'displayFd' in ready
    // Capture stderr so a startup failure can be diagnosed.
    const stdio: Array<'ignore' | 'pipe'> = ['ignore', 'ignore', 'pipe']
    if (displayFd) {
        stdio.push(...new Array<'ignore'>(DISPLAY_FD - stdio.length).fill('ignore'), 'pipe')
    }
    const proc = spawn(command, args, { stdio, ...(spawnEnv ? { env: spawnEnv } : {}) })

    // Keep only the tail of stderr to bound memory.
    let stderr = ''
    proc.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4096)
    })

    let rejectExit!: (err: Error) => void
    const exitPromise = new Promise<never>((_, reject) => { rejectExit = reject })
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        rejectExit(new Error(`${label} process exited unexpectedly (code=${code}, signal=${signal})${stderr ? `\n${stderr.trim()}` : ''}`))
    const onError = (err: Error) =>
        rejectExit(new Error(`${label} process error: ${err.message}`))
    proc.once('exit', onExit)
    proc.once('error', onError)

    // A spawn that fails with EMFILE or ENFILE has no stdio; its 'error' event rejects exitPromise.
    const displayStream = displayFd ? proc.stdio?.[DISPLAY_FD] as Readable | undefined : undefined
    // An unhandled 'error' after readline detaches would crash the process.
    displayStream?.on('error', (err) => log.debug(`${label} fd ${DISPLAY_FD} error: ${err.message}`))

    // Resolve only once the process has actually exited, so cleanup never runs while
    // it's still alive. The 2s fallback prevents a wedge if 'exit' is never reported after SIGKILL.
    const terminate = async (): Promise<void> => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
            return
        }
        proc.kill('SIGTERM')
        await new Promise<void>((resolve) => {
            const sigkillTimer = setTimeout(() => {
                if (proc.exitCode === null && proc.signalCode === null) {
                    proc.kill('SIGKILL')
                }
            }, 1000)
            const fallbackTimer = setTimeout(() => {
                proc.removeListener('exit', onProcExit)
                resolve()
            }, 2000)
            function onProcExit () {
                clearTimeout(sigkillTimer)
                clearTimeout(fallbackTimer)
                resolve()
            }
            proc.once('exit', onProcExit)
        })
    }

    // Stop the readiness wait once the race settles, so a premature crash doesn't
    // leave it polling in the background.
    const readyWait = new AbortController()
    let env: Record<string, string>
    try {
        let readiness: Promise<Record<string, string>>
        if (!displayFd) {
            readiness = waitForSocket(ready.socketPath, timeoutMs, ready.socketLabel, readyWait.signal).then(() => ready.env)
        } else if (displayStream) {
            readiness = readDisplayNumber(displayStream, timeoutMs, label, readyWait.signal, () => stderr.trim()).then((display) => {
                log.info(`${label} reported display ${display} on fd ${DISPLAY_FD}`)
                return ready.env(display)
            })
        } else {
            readiness = exitPromise
        }
        env = await Promise.race([readiness, exitPromise])
    } catch (err) {
        proc.removeListener('exit', onExit)
        proc.removeListener('error', onError)
        await terminate()
        await cleanup?.()
        throw err
    } finally {
        readyWait.abort()
    }
    proc.removeListener('exit', onExit)
    proc.removeListener('error', onError)

    // syncDone short-circuits stop() so a prior stopSync() isn't undone by a redundant
    // async cleanup, while still letting stopSync() run during an in-flight stop() —
    // otherwise an exit mid-stop() would orphan the child.
    let stopPromise: Promise<void> | null = null
    let syncDone = false
    const stop = (): Promise<void> => {
        if (syncDone) {
            return Promise.resolve()
        }
        if (stopPromise) {
            return stopPromise
        }
        stopPromise = (async () => {
            log.info(`Stopping ${label} daemon`)
            await terminate()
            await cleanup?.()
        })()
        return stopPromise
    }

    const stopSync = (): void => {
        if (syncDone) {
            return
        }
        syncDone = true
        try {
            if (proc.exitCode === null && proc.signalCode === null) {
                proc.kill('SIGKILL')
            }
        } catch { /* process may already be gone */ }
        cleanupSync?.()
    }

    return { env, stop, stopSync }
}
