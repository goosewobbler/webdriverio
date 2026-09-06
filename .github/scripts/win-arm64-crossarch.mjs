// Confirms, on real Windows ARM64 hardware, the assumption behind letting WebdriverIO use the
// standard win64 (x64) Chromedriver on Windows ARM64: that the x64 Chromedriver runs under
// Windows' transparent x64 emulation and drives a *native* ARM64 Chrome over CDP.
//
// It verifies the architecture of both binaries from their PE headers (so the result is
// unambiguous), then runs a real WebDriver session: create → navigate → read title.
// Exits non-zero on any failure so CI goes red if the assumption ever stops holding.

import { execSync, spawn } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const PORT = 9515

/** Reads the COFF machine field from a PE (.exe) file → architecture string. */
function peMachine(file) {
    const fd = openSync(file, 'r')
    try {
        const b = Buffer.alloc(4)
        readSync(fd, b, 0, 4, 0x3c)          // e_lfanew: offset of the PE header
        const peOff = b.readUInt32LE(0)
        const m = Buffer.alloc(2)
        readSync(fd, m, 0, 2, peOff + 4)     // Machine field follows the 4-byte "PE\0\0" signature
        const machine = m.readUInt16LE(0)
        return { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' }[machine] ?? `0x${machine.toString(16)}`
    } finally {
        closeSync(fd)
    }
}

function findChrome() {
    const candidates = [
        `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    ]
    const found = candidates.find((p) => p && existsSync(p))
    if (!found) {
        throw new Error(`Google Chrome not found. Looked in:\n  ${candidates.join('\n  ')}`)
    }
    return found
}

function chromeVersion(chrome) {
    // Chrome installs a version-named folder (e.g. Application\152.0.7977.82) next to chrome.exe.
    const version = readdirSync(dirname(chrome)).find((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
    if (!version) {
        throw new Error(`Could not determine Chrome version from ${dirname(chrome)}`)
    }
    return version
}

async function downloadWin64Chromedriver(version, dir) {
    const build = version.split('.').slice(0, 3).join('.') // major.minor.build
    const res = await fetch('https://googlechromelabs.github.io/chrome-for-testing/latest-patch-versions-per-build-with-downloads.json')
    if (!res.ok) {
        throw new Error(`Failed to fetch Chrome for Testing index: HTTP ${res.status}`)
    }
    const data = await res.json()
    const entry = data.builds?.[build]
    const url = entry?.downloads?.chromedriver?.find((d) => d.platform === 'win64')?.url
    if (!url) {
        throw new Error(`Chrome for Testing has no win64 Chromedriver for build ${build} (Chrome ${version})`)
    }
    console.log(`  Chrome for Testing win64 Chromedriver for ${build}: ${entry.version}`)
    const zip = join(dir, 'chromedriver.zip')
    const dl = await fetch(url)
    if (!dl.ok) {
        throw new Error(`Failed to download Chromedriver: HTTP ${dl.status}`)
    }
    writeFileSync(zip, Buffer.from(await dl.arrayBuffer()))
    execSync(`tar -xf "${zip}" -C "${dir}"`) // bsdtar (built into Windows) extracts zips
    const exe = join(dir, 'chromedriver-win64', 'chromedriver.exe')
    if (!existsSync(exe)) {
        throw new Error(`Chromedriver not found after extraction at ${exe}`)
    }
    return exe
}

async function waitForReady() {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`http://localhost:${PORT}/status`)
            if ((await r.json())?.value?.ready) {
                return
            }
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Chromedriver did not become ready')
}

async function wd(method, path, body) {
    const r = await fetch(`http://localhost:${PORT}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    })
    return r.json()
}

async function main() {
    const dir = mkdtempSync(join(tmpdir(), 'crossarch-'))
    const chrome = findChrome()
    const version = chromeVersion(chrome)
    console.log(`Chrome: ${chrome}\n  version ${version}`)

    const driver = await downloadWin64Chromedriver(version, dir)

    const chromeArch = peMachine(chrome)
    const driverArch = peMachine(driver)
    console.log(`\nArchitectures — chrome: ${chromeArch}, chromedriver: ${driverArch}`)
    if (chromeArch !== 'arm64') {
        throw new Error(`Expected a native ARM64 Chrome, got ${chromeArch}. This runner isn't testing the cross-arch case.`)
    }
    if (driverArch !== 'x64') {
        throw new Error(`Expected the x64 (win64) Chromedriver, got ${driverArch}.`)
    }

    console.log('\nStarting x64 Chromedriver…')
    const cd = spawn(driver, [`--port=${PORT}`], { stdio: 'inherit' })
    try {
        await waitForReady()
        console.log('Creating session (x64 driver → native ARM64 Chrome)…')
        const created = await wd('POST', '/session', {
            capabilities: {
                alwaysMatch: {
                    browserName: 'chrome',
                    'goog:chromeOptions': {
                        binary: chrome,
                        args: ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dir, 'profile')}`]
                    }
                }
            }
        })
        const sessionId = created?.value?.sessionId
        if (!sessionId) {
            throw new Error(`Session not created: ${JSON.stringify(created)}`)
        }
        console.log(`  sessionId: ${sessionId}`)

        await wd('POST', `/session/${sessionId}/url`, { url: 'data:text/html,<title>CrossArchOK</title>hi' })
        const title = (await wd('GET', `/session/${sessionId}/title`))?.value
        await wd('DELETE', `/session/${sessionId}`)

        if (title !== 'CrossArchOK') {
            throw new Error(`Unexpected title: ${JSON.stringify(title)}`)
        }
        console.log(`\n✅ PASS — x64 Chromedriver drove native ARM64 Chrome (title read back: "${title}")`)
    } finally {
        cd.kill()
    }
}

main().catch((err) => {
    console.error(`\n❌ FAIL — ${err.message}`)
    process.exit(1)
})
