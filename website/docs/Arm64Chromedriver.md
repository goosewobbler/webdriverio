---
id: arm64-chromedriver
title: Chromedriver on ARM64
---

WebdriverIO sets up Chromedriver automatically on ARM64, but the two ARM64 desktop platforms get there differently. This page explains what happens on each, and how to handle the one case that can fail — a Chrome milestone on Linux ARM64 that no download source can serve yet.

## Windows on ARM — works out of the box

Chrome for Testing doesn't publish a `win-arm64` Chromedriver, but this isn't a problem in practice: Windows on ARM runs x64 binaries through built-in, transparent [emulation](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation), and Chrome for Testing always ships the `win64` (x64) Chromedriver. So WebdriverIO uses that x64 Chromedriver, which runs under emulation and drives your **native ARM64 Chrome** over the (architecture-agnostic) DevTools protocol. No configuration, no separate download — it just works.

If you're testing an **Electron app** on Windows ARM64, or want the native ARM64 Chromedriver specifically, opt in with a capability (see [ARM64 via Electron releases](#arm64-via-electron-releases) below). And [Microsoft Edge](#alternative-microsoft-edge) is a fully-supported native-ARM64 alternative.

## Linux on ARM — Chrome for Testing, with an Electron fallback

Chrome for Testing builds `linux-arm64` Chromedriver from Chromium **154** onward (currently rolling out through the Beta/Dev/Canary channels to Stable). On a milestone Chrome for Testing serves, WebdriverIO uses it directly.

Below that floor, there is no `linux-arm64` Chromedriver from Chrome for Testing and no transparent x64 emulation on Linux, so WebdriverIO falls back to the Chromedriver bundled inside a matching **[Electron release](https://github.com/electron/electron/releases)** — the only version-pinned ARM64 Chromedriver that can be downloaded on demand. This usually works, but has a coverage gap (below).

## The Linux ARM64 fallback gap

ChromeDriver requires the first three version components — `major.minor.build` — to match the browser (the patch, the fourth, is flexible). Electron only ships a Chromedriver for the specific Chromium **builds** Electron itself released, and those don't always include your Chrome's build. When they don't — and Chrome for Testing has no `linux-arm64` binary for it either — no compatible Chromedriver exists anywhere, and WebdriverIO **fails cleanly** rather than install a mismatched driver (which would break sessions in confusing ways).

:::info Why builds diverge — and why it isn't a "respin"
Each Chrome major has a **single** stable build number (e.g. Chrome 152 stable is always `152.0.7977.x`). Electron independently pins its stable to **one** Chromium build per milestone, and the two don't always coincide — Electron sometimes freezes an older major at a build below Chrome's final stable build, and a brand-new Chrome major has no Electron release at all until Electron catches up. So the gap is about *which builds Electron happened to ship*, not about Chrome re-releasing a milestone.
:::

### Mitigations

1. **Use Chrome/Chromium ≥ the Chrome for Testing ARM64 floor (154+).** Once you're on a milestone Chrome for Testing serves, the Electron fallback never runs. This is the durable fix — the gap closes on its own as 154+ reaches Stable.
2. **Use the distribution's Chromium and driver.** Debian/Ubuntu (and derivatives) build a matched `arm64` pair:
   ```bash
   sudo apt-get install -y chromium chromium-driver
   ```
   ```ts
   capabilities: [{
       browserName: 'chrome',
       'goog:chromeOptions': { binary: '/usr/bin/chromium' },
       'wdio:chromedriverOptions': { binary: '/usr/bin/chromedriver' }
   }]
   ```
3. **Pin to a Chromium version an Electron release covers**, via `wdio:chromiumVersion` (or `wdio:electronVersion` for an Electron app) — see below.
4. **Bring your own Chromedriver** — point WebdriverIO at one you obtained yourself; this disables the download entirely:
   ```ts
   capabilities: [{
       browserName: 'chrome',
       'wdio:chromedriverOptions': { binary: '/path/to/chromedriver' }
   }]
   ```

## ARM64 via Electron releases

Setting either capability sources the Chromedriver from a matching Electron release (bundled ARM64 Chromedriver), on both Linux and Windows ARM64. This is aimed at **Electron apps**, whose Chromium is guaranteed to be an Electron-shipped build:

```ts
capabilities: [{
    browserName: 'chrome',
    'wdio:electronVersion': '39.0.0'          // download the Chromedriver bundled with this Electron release
    // or: 'wdio:chromiumVersion': '152.0.7977.76'  // a Chromium build an Electron release shipped
}]
```

On Chrome-for-Testing-served platforms, a failed Electron download falls back to a Chrome-for-Testing build for the same major, so a stray version still resolves.

## Alternative: Microsoft Edge

Edge is built on the same Chromium engine as Chrome, has **native `win-arm64` builds**, and ships an **official ARM64 WebDriver** (`edgedriver_arm64.zip` from [msedgedriver.microsoft.com](https://developer.microsoft.com/microsoft-edge/tools/webdriver/)). WebdriverIO drives it as a first-class browser — no extra service — and for the vast majority of web apps it renders identically to Chrome:

```ts
capabilities: [{ browserName: 'MicrosoftEdge' }]
```

## Why not just use the nearest driver?

WebdriverIO deliberately **won't** install a Chromedriver whose `major.minor.build` differs from your Chrome, even when one is close. A build-mismatched driver either refuses to start a session or — worse — starts one that misbehaves in subtle, hard-to-diagnose ways. A clear failure you can act on is safer than a driver that silently doesn't match.
