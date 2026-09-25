import path from 'node:path'
import type * as ChildProcessModule from 'node:child_process'
import { expect, test, vi, beforeEach } from 'vitest'

import type * as DisplayServerModule from '@wdio/display-server'
import LocalRunner from '../src/index.js'

const sleep = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
    vi.clearAllMocks()
})

vi.mock(
    '@wdio/logger',
    () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger'))
)

const childProcessMock = {
    on: vi.fn(),
    send: vi.fn(),
    kill: vi.fn(),
    stdout: { pipe: vi.fn() },
    stderr: { pipe: vi.fn() },
}

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof ChildProcessModule>()
    return {
        ...actual,
        fork: vi.fn().mockImplementation(() => childProcessMock),
    }
})

vi.mock('@wdio/display-server', async () => {
    // Use the real optionsFromConfig so the mapping under test runs through;
    // mock only the runtime classes that would otherwise pull in display-server
    // side-effects.
    const actual = await vi.importActual<typeof DisplayServerModule>('@wdio/display-server')
    return {
        ...actual,
        DisplayServerManager: vi.fn().mockImplementation(() => ({
            shouldRun: vi.fn().mockReturnValue(true),
            injectDisplayFlags: vi.fn(),
            getDisplayServer: vi.fn().mockReturnValue(null),
        })),
        // The daemon-start path lives in startDisplayDaemonFromConfig now.
        // Default to "no daemon needed" (null) so non-daemon tests don't have
        // to mock around the eager initialize().
        startDisplayDaemonFromConfig: vi.fn().mockResolvedValue(null),
        default: vi.fn()
    }
})

test('should map new displayServer* options through to DisplayServerManager', async () => {
    const displayServer = await import('@wdio/display-server')
    new LocalRunner(
        {} as never,
        {
            displayServer: 'wayland',
            displayServerEnabled: true,
            displayServerAutoInstall: true,
            displayServerAutoInstallMode: 'sudo',
            displayServerAutoInstallCommand: 'custom-cmd',
        } as any
    )

    expect(vi.mocked(displayServer.DisplayServerManager)).toHaveBeenCalledWith(
        expect.objectContaining({
            displayServer: 'wayland',
            enabled: true,
            autoInstall: true,
            autoInstallMode: 'sudo',
            autoInstallCommand: 'custom-cmd',
        })
    )
})

test('should fork a new process', async () => {
    const runner = new LocalRunner(
        {} as never,
        {
            outputDir: '/foo/bar',
            runnerEnv: { FORCE_COLOR: 1 },
            displayServerEnabled: true
        } as any
    )
    const worker = await runner.run({
        cid: '0-5',
        command: 'run',
        configFile: '/path/to/wdio.conf.js',
        args: {},
        caps: {},
        specs: ['/foo/bar.test.js'],
        execArgv: [],
        retries: 0,
    })
    worker['_handleMessage']({ name: 'ready' } as any)
    await sleep()

    expect(worker.isBusy).toBe(true)
    expect(worker.childProcess?.on).toHaveBeenCalled()

    expect(worker.childProcess?.send).toHaveBeenCalledWith({
        args: {},
        caps: {},
        cid: '0-5',
        command: 'run',
        configFile: '/path/to/wdio.conf.js',
        retries: 0,
        specs: ['/foo/bar.test.js'],
    })

    await worker.postMessage('runAgain', { foo: 'bar' } as any)
})

test('should shut down worker processes', async () => {
    const runner = new LocalRunner(
        {} as never,
        {
            outputDir: '/foo/bar',
            runnerEnv: { FORCE_COLOR: 1 },
            displayServerEnabled: true
        } as any
    )
    const worker1 = await runner.run({
        cid: '0-4',
        command: 'run',
        configFile: '/path/to/wdio.conf.js',
        args: {},
        caps: {},
        specs: ['/foo/bar2.test.js'],
        execArgv: [],
        retries: 0,
    })
    worker1['_handleMessage']({ name: 'ready' } as any)
    await sleep()
    const worker2 = await runner.run({
        cid: '0-5',
        command: 'run',
        configFile: '/path/to/wdio.conf.js',
        args: {},
        caps: {},
        specs: ['/foo/bar.test.js'],
        execArgv: [],
        retries: 0,
    })
    worker2['_handleMessage']({ name: 'ready' } as any)
    await sleep()
    setTimeout(() => {
        worker1.isBusy = false
        setTimeout(() => {
            worker2.isBusy = false
        }, 260)
    }, 260)

    const before = Date.now()
    await runner.shutdown()
    const after = Date.now()

    expect(after - before).toBeGreaterThanOrEqual(740)
    const call1: any = vi.mocked(worker1.childProcess?.send)!.mock.calls.pop()![0]
    expect(call1.cid).toBe('0-5')
    expect(call1.command).toBe('endSession')
    const call2: any = vi
        .mocked(worker1.childProcess?.send)!
        .mock.calls.pop()![0]
    expect(call2.cid).toBe('0-4')
    expect(call2.command).toBe('endSession')
})

test('should avoid shutting down if worker is not busy', async () => {
    const runner = new LocalRunner(
        {} as never,
        {
            outputDir: '/foo/bar',
            runnerEnv: { FORCE_COLOR: 1 },
            displayServerEnabled: true
        } as any
    )

    await runner.run({
        cid: '0-8',
        command: 'run',
        configFile: '/path/to/wdio.conf.js',
        args: { sessionId: 'abc' } as any,
        caps: {},
        specs: ['/foo/bar2.test.js'],
        execArgv: [],
        retries: 0,
    })
    runner.workerPool['0-8'].isBusy = false

    await runner.shutdown()

    expect(runner.workerPool['0-8']).toBeFalsy()
})

test('should shut down worker processes in watch mode - regular', async () => {
    const runner = new LocalRunner(
        {} as never,
        {
            outputDir: '/foo/bar',
            runnerEnv: { FORCE_COLOR: 1 },
            watch: true,
            displayServerEnabled: true
        } as any
    )

    const worker = await runner.run({
        cid: '0-6',
        command: 'run',
        configFile: '/path/to/wdio.conf.js',
        args: { sessionId: 'abc' } as any,
        caps: {},
        specs: ['/foo/bar2.test.js'],
        execArgv: [],
        retries: 0,
    })
    worker['_handleMessage']({ name: 'ready' } as any)
    runner.workerPool['0-6'].sessionId = 'abc'
    runner.workerPool['0-6'].server = { host: 'foo' }
    runner.workerPool['0-6'].caps = { browser: 'chrome' } as any

    setTimeout(() => {
        worker.isBusy = false
    }, 260)

    const before = Date.now()
    await runner.shutdown()
    const after = Date.now()

    expect(after - before).toBeGreaterThanOrEqual(300)

    const call: any = vi
        .mocked(worker.childProcess?.send)!
        .mock.calls.pop()![0]
    expect(call.cid).toBe('0-6')
    expect(call.command).toBe('endSession')
    expect(call.args.watch).toBe(true)
    expect(call.args.isMultiremote).toBeFalsy()
    expect(call.args.config.sessionId).toBe('abc')
    expect(call.args.config.host).toEqual('foo')
})

test('should shut down worker processes in watch mode - mutliremote', async () => {
    const runner = new LocalRunner(
        {} as never,
        {
            outputDir: '/foo/bar',
            runnerEnv: { FORCE_COLOR: 1 },
            watch: true,
            displayServerEnabled: true
        } as any
    )

    const worker = await runner.run({
        cid: '0-7',
        command: 'run',
        configFile: '/path/to/wdio.conf.js',
        args: {},
        caps: {},
        specs: ['/foo/bar.test.js'],
        execArgv: [],
        retries: 0,
    })
    worker['_handleMessage']({ name: 'ready' } as any)
    runner.workerPool['0-7'].isMultiremote = true
    runner.workerPool['0-7'].instances = { foo: { sessionId: '123' } }
    runner.workerPool['0-7'].caps = {
        foo: {
            capabilities: { browser: 'chrome' },
        },
    } as any

    setTimeout(() => {
        worker.isBusy = false
    }, 260)

    const before = Date.now()
    await runner.shutdown()
    const after = Date.now()

    expect(after - before).toBeGreaterThanOrEqual(300)

    const call: any = vi
        .mocked(worker.childProcess?.send)!
        .mock.calls.pop()![0]
    expect(call.cid).toBe('0-7')
    expect(call.command).toBe('endSession')
    expect(call.args.watch).toBe(true)
    expect(call.args.isMultiremote).toBe(true)
    expect(call.args.instances).toEqual({ foo: { sessionId: '123' } })
})

test('should avoid shutting down if worker is not busy', async () => {
    const runner = new LocalRunner({} as never, {
        displayServerEnabled: true
    } as any)
    expect(await runner.initialize()).toBe(undefined)
})

test('starts a display-server daemon during initialize() when one is needed', async () => {
    const displayServer = await import('@wdio/display-server')
    const stopSpy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(displayServer.startDisplayDaemonFromConfig).mockResolvedValueOnce({ stop: stopSpy })

    const config = { displayServerEnabled: true } as WebdriverIO.Config
    const runner = new LocalRunner({} as never, config)
    await runner.initialize()

    // The runner's own manager, so the one that later injects flags knows the active server.
    expect(displayServer.startDisplayDaemonFromConfig).toHaveBeenCalledTimes(1)
    expect(displayServer.startDisplayDaemonFromConfig).toHaveBeenCalledWith(config, runner['displayServerManager'])
})

test('continues without a display when starting the daemon throws', async () => {
    const displayServer = await import('@wdio/display-server')
    vi.mocked(displayServer.startDisplayDaemonFromConfig).mockRejectedValueOnce(new Error('mkdtemp ENOSPC'))

    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as WebdriverIO.Config)

    await expect(runner.initialize()).resolves.toBeUndefined()
    expect(runner['daemon']).toBeNull()
    await runner.shutdown()
})

test('shuts down cleanly when startDisplayDaemonFromConfig returns null', async () => {
    const displayServer = await import('@wdio/display-server')
    vi.mocked(displayServer.startDisplayDaemonFromConfig).mockResolvedValueOnce(null)

    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as any)
    await runner.initialize()

    expect(displayServer.startDisplayDaemonFromConfig).toHaveBeenCalledTimes(1)
    // No daemon was started, so neither teardown step has anything to stop.
    await runner.shutdown()
    await runner.dispose()
})

test('keeps the daemon through shutdown() and stops it in dispose()', async () => {
    const displayServer = await import('@wdio/display-server')
    const stopSpy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(displayServer.startDisplayDaemonFromConfig).mockResolvedValueOnce({ stop: stopSpy })

    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as any)
    await runner.initialize()
    await runner.shutdown()

    // onComplete runs between the two; a driver started in onPrepare still needs the display.
    expect(stopSpy).not.toHaveBeenCalled()

    await runner.dispose()

    expect(stopSpy).toHaveBeenCalledTimes(1)
})

test('dispose() waits for the daemon to stop', async () => {
    const displayServer = await import('@wdio/display-server')
    let finishStop!: () => void
    const stop = vi.fn(() => new Promise<void>((resolve) => {
        finishStop = resolve
    }))
    vi.mocked(displayServer.startDisplayDaemonFromConfig).mockResolvedValueOnce({ stop })

    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as any)
    await runner.initialize()
    let disposed = false
    const disposing = runner.dispose().then(() => {
        disposed = true
    })
    await new Promise((r) => setImmediate(r))

    expect(disposed).toBe(false)
    finishStop()
    await disposing
    expect(disposed).toBe(true)
})

function stubInjection (runner: LocalRunner) {
    const mockInject = vi.fn()
    runner['displayServerManager'] = { injectDisplayFlags: mockInject } as unknown as DisplayServerModule.DisplayServerManager
    return mockInject
}

function runPayload (caps: WebdriverIO.Capabilities, cid = '0-a') {
    return {
        cid,
        command: 'run',
        configFile: '/path/to/wdio.conf.js',
        args: {},
        caps,
        specs: ['/foo/a.test.js'],
        execArgv: [],
        retries: 0,
    }
}

test('injects display flags into every spawned worker (independent of daemon state)', async () => {
    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)
    const caps1 = { browserName: 'chrome' }
    const caps2 = { browserName: 'firefox' }

    await runner.run(runPayload(caps1, '0-a'))
    await runner.run(runPayload(caps2, '0-b'))

    // injectDisplayFlags fires per worker so Chrome/Edge get
    // --ozone-platform=wayland on every spec when Wayland is in play.
    expect(mockInject).toHaveBeenCalledTimes(2)
    expect(mockInject).toHaveBeenNthCalledWith(1, caps1)
    expect(mockInject).toHaveBeenNthCalledWith(2, caps2)
})

test.each([
    ['a grid hostname', { hostname: 'selenium-grid.internal' }],
    ['a custom port', { port: 4444 }],
    ['cloud credentials', { user: 'me', key: 'secret' }],
])('skips display flag injection when the config defines a remote driver via %s', async (_label, connection) => {
    const runner = new LocalRunner({} as never, { displayServerEnabled: true, ...connection } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)

    await runner.run(runPayload({ browserName: 'chrome' }))

    // The browser starts on the grid or cloud host, not on this display.
    expect(mockInject).not.toHaveBeenCalled()
})

test('skips display flag injection when the capability itself targets a remote driver', async () => {
    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)

    await runner.run(runPayload({ browserName: 'chrome', hostname: 'selenium-grid.internal', port: 4444 }))

    expect(mockInject).not.toHaveBeenCalled()
})

test('skips display flag injection when W3C capabilities target a remote driver in alwaysMatch', async () => {
    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)

    await runner.run(runPayload({ alwaysMatch: { browserName: 'chrome', hostname: 'selenium-grid.internal', port: 4444 }, firstMatch: [{}] } as never))

    expect(mockInject).not.toHaveBeenCalled()
})

test('ignores connection options at the root of W3C capabilities, as the worker does', async () => {
    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)

    const caps = { alwaysMatch: { browserName: 'chrome' }, firstMatch: [{}], hostname: 'selenium-grid.internal' }

    await runner.run(runPayload(caps as never))

    expect(mockInject).toHaveBeenCalledWith(caps)
})

test('tolerates a worker without capabilities', async () => {
    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)

    await runner.run(runPayload(undefined as never))

    expect(mockInject).toHaveBeenCalledWith(undefined)
})

test('still injects display flags into local W3C capabilities', async () => {
    const runner = new LocalRunner({} as never, { displayServerEnabled: true } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)
    const caps = { alwaysMatch: { browserName: 'chrome' }, firstMatch: [{}] }

    await runner.run(runPayload(caps as never))

    expect(mockInject).toHaveBeenCalledWith(caps)
})

test('still injects display flags when the config spells out the local defaults', async () => {
    const runner = new LocalRunner({} as never, {
        displayServerEnabled: true,
        hostname: 'localhost',
        protocol: 'http',
        path: '/',
    } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)
    const caps = { browserName: 'chrome' }

    await runner.run(runPayload(caps))

    expect(mockInject).toHaveBeenCalledTimes(1)
    expect(mockInject).toHaveBeenCalledWith(caps)
})

test('lets a capability override a remote config back to local, as the worker does', async () => {
    const runner = new LocalRunner({} as never, { displayServerEnabled: true, hostname: 'grid.internal' } as WebdriverIO.Config)
    const mockInject = stubInjection(runner)
    const caps = { browserName: 'chrome', hostname: 'localhost' }

    await runner.run(runPayload(caps))

    expect(mockInject).toHaveBeenCalledWith(caps)
})
