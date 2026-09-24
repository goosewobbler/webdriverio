/**
 * Test stub standing in for the `weston` compositor, driven by WDIO_STUB_MODE.
 *
 * Modes:
 * - 'ready' (default): create the socket the parent polls for, then idle until
 *   signalled (exit cleanly on SIGTERM/SIGINT).
 * - 'ignore-sigterm': create the socket and idle, but swallow SIGTERM so the
 *   caller must escalate to SIGKILL.
 * - 'crash': write to stderr and exit non-zero without creating the socket.
 */
import fs from 'node:fs'
import path from 'node:path'

// The version probe runs `weston --version` before spawning the daemon.
if (process.argv.includes('--version')) {
    process.stdout.write('weston 13.0.0\n')
    process.exit(0)
}

const mode = process.env.WDIO_STUB_MODE || 'ready'
const socketArg = process.argv.find((arg) => arg.startsWith('--socket='))
const socketName = socketArg?.slice('--socket='.length)
const runtimeDir = process.env.XDG_RUNTIME_DIR

if (mode === 'crash') {
    // Synchronous, so the line is written before the immediate exit.
    fs.writeSync(2, 'weston: fatal: simulated startup failure\n')
    process.exit(1)
} else {
    if (socketName && runtimeDir) {
        fs.writeFileSync(path.join(runtimeDir, socketName), '')
    }

    // Keep the event loop alive so the process idles until signalled.
    const keepAlive = setInterval(() => {}, 1 << 30)
    const quit = () => {
        clearInterval(keepAlive)
        process.exit(0)
    }

    process.on('SIGINT', quit)
    if (mode === 'ignore-sigterm') {
        process.on('SIGTERM', () => { /* swallow → caller must SIGKILL */ })
    } else {
        process.on('SIGTERM', quit)
    }
}
