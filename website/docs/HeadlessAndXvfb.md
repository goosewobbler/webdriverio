---
id: headless-and-xvfb
title: Headless & Xvfb with the Testrunner
description: How the WebdriverIO testrunner starts a virtual display with Weston or Xvfb for headless testing on Linux, its options, CI recipes, and troubleshooting.
---

On Linux, when no display is available, the testrunner starts a virtual display server for the run: [Weston](https://gitlab.freedesktop.org/wayland/weston) in headless mode, or Xvfb (X Virtual Framebuffer) as a fallback. This page covers when that happens, how to configure it, and how it behaves in CI and Docker.

## When to use a virtual display vs native headless

- Use native headless (e.g., Chrome `--headless=new`) when possible for minimal overhead. Set `displayServerEnabled: false` too, or the runner still starts a display server.
- Use a virtual display when:
  - Testing Electron or Tauri apps, which need a real window
  - You rely on GLX or window-manager dependent behaviors
  - Your tooling expects a display server (`DISPLAY` or `WAYLAND_DISPLAY`)
  - You run into Chromium errors such as:
    - `session not created: probably user data directory is already in use ...`
    - `Chrome failed to start: exited abnormally. (DevToolsActivePort file doesn't exist)`
    The user data directory collision error can be misleading as it is often the result of a browser crash and immediate restart that reuses the same profile directory from the prior instance. Ensuring a stable display often resolves it - if not, you should pass a unique `--user-data-dir` per worker.

## How it works

The runner starts one display server before any service's `onPrepare` hook and sets `WAYLAND_DISPLAY` or `DISPLAY` on `process.env`, along with matching `GDK_BACKEND` and `ELECTRON_OZONE_PLATFORM_HINT` values. Workers inherit them, and so do drivers and apps that services start in `onPrepare`. The display is stopped after the `onComplete` hook, so services can still use it while they tear down.

The runner only starts a display server when all of these are true:

- It runs on Linux.
- Neither `DISPLAY` nor `WAYLAND_DISPLAY` is set.
- `displayServerEnabled` is not `false`.

If a display already exists, the runner uses it and starts nothing.

### Which display server is used

With the default `displayServer: 'auto'`, the runner tries Weston first and Xvfb second. Installed servers are tried before anything is installed, so an existing Xvfb is used instead of installing Weston. If no display server starts, the runner logs a warning and the run continues without one.

With `displayServer: 'wayland'` or `displayServer: 'xvfb'`, the runner only tries that server.

Weston 10 and later are supported. If Weston fails to start, auto mode falls back to Xvfb.

Weston starts without Xwayland, so it provides no `DISPLAY` and no GLX. If your tests or tools need X11, for example `xdotool` or a Java app, set `displayServer: 'xvfb'`.

WebdriverIO also adds a matching `--ozone-platform` flag to the Chrome, Edge and Electron sessions it drives: `wayland` under Weston and `x11` under Xvfb. When it starts no display server because only `WAYLAND_DISPLAY` is set, it still adds `--ozone-platform=wayland`, unless `displayServerEnabled` is `false`.

### Parallel workers share one display

All workers use the same display. In WebdriverIO v9, each worker was wrapped in `xvfb-run` and got a display of its own. If your tests depend on which window has focus, run them with `maxInstances: 1`.

## Configuration

- `displayServerEnabled` (boolean, default: `true`)
  - Set to `false` to never start a display server.

- `displayServer` (`'auto'` | `'wayland'` | `'xvfb'`, default: `'auto'`)
  - Which display server to start. `'auto'` tries Weston, then Xvfb.

- `displayServerAutoInstall` (boolean, default: `false`)
  - Install a missing display server with the system package manager, when no installed one starts.
  - When `false`, the runner warns and continues without installing.

- `displayServerAutoInstallMode` (`'root'` | `'sudo'`, default: `'sudo'`)
  - `'root'`: install only when running as root.
  - `'sudo'`: when not root, install with non-interactive `sudo -n`, or without `sudo` if it isn't installed.
  - Both modes apply to the built-in install only. A custom install command always runs.

- `displayServerAutoInstallCommand` (string | string[], optional)
  - A command to run instead of the built-in package-manager install. It runs as-is, without `sudo`.
  - A string runs in a shell. An array runs as a command and its arguments, without a shell.
  - In auto mode it runs for each missing server in turn, Weston first, so set `displayServer` to the server it installs.

- `displayServerWidth` (number, default: `1920`) and `displayServerHeight` (number, default: `1080`)
  - Screen size in pixels.

- `displayServerDepth` (number, default: `24`)
  - Color depth. Xvfb only.

Examples:

```ts
export const config: WebdriverIO.Config = {
  // Install a display server with sudo if none is installed
  displayServerAutoInstall: true,
  displayServerAutoInstallMode: 'sudo',

  capabilities: [{
    browserName: 'chrome',
    'goog:chromeOptions': { args: ['--no-sandbox'] }
  }]
}
```

```ts
export const config: WebdriverIO.Config = {
  // Always use Xvfb at a smaller size, installed by a custom command that assumes a root container
  displayServer: 'xvfb',
  displayServerAutoInstall: true,
  displayServerAutoInstallCommand: 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb',
  displayServerWidth: 1280,
  displayServerHeight: 720,

  capabilities: [{
    browserName: 'chrome',
    'goog:chromeOptions': { args: ['--no-sandbox'] }
  }]
}
```

The `autoXvfb` and `xvfbAutoInstall*` options of WebdriverIO v9 still work but log a deprecation warning, and `xvfbMaxRetries` and `xvfbRetryDelay` have no effect. See the [v10 migration guide](/docs/v10-migration#virtual-displays-on-linux) for their replacements.

## Using an existing display in CI

If your CI already provides a display, the runner uses it and starts nothing. For example, you can wrap the run in `xvfb-run -a npx wdio run ./wdio.conf.ts`, or start your own X server and export `DISPLAY`.

To make sure the runner never starts a display server, set `displayServerEnabled: false`.

## Drivers you start yourself

WebdriverIO only adds the `--ozone-platform` flag to sessions it drives itself. If your config sets `hostname`, `port` or another connection option for a Chrome, Edge or Electron driver that a service starts in `onPrepare`, set `displayServer: 'xvfb'`, which needs no browser flag. A fixed `--ozone-platform=wayland` breaks whenever the run doesn't end up on Weston. A driver started before WebdriverIO, for example in another shell, doesn't inherit the runner's display at all, so start it from `onPrepare` or give it a display of its own. Grid and cloud sessions need nothing, since their browsers run on the remote host's own display.

## CI and Docker recipes

GitHub Actions (using native headless, with `displayServerEnabled: false` in your config):

```yaml
- name: Run tests
  run: npx wdio run ./wdio.conf.ts
```

GitHub Actions (install a display server if none is present):

```ts
// wdio.conf.ts
export const config = {
  displayServerAutoInstall: true
}
```

Docker (Ubuntu/Debian example, preinstalling Weston):

```Dockerfile
RUN apt-get update -qq && apt-get install -y weston
```

Install `xvfb` instead to use Xvfb. For other distributions, use the package names in the table below.

## Automatic installation support

When `displayServerAutoInstall` is enabled, WebdriverIO installs a missing display server with your system package manager, Weston first. Installs are non-interactive. The following managers and packages are supported:

| Package Manager | Command         | Distributions (examples)                               | Weston   | Xvfb                                            |
|-----------------|-----------------|--------------------------------------------------------|----------|-------------------------------------------------|
| apt             | `apt-get`       | Ubuntu, Debian, Pop!_OS, Mint, Elementary, Zorin, etc. | `weston` | `xvfb`                                          |
| dnf             | `dnf`           | Fedora, Rocky Linux, AlmaLinux, Nobara, Bazzite, etc.  | `weston` | `xorg-x11-server-Xvfb` `xorg-x11-server-utils` |
| yum             | `yum`           | CentOS, RHEL (legacy)                                  | `weston` | `xorg-x11-server-Xvfb` `xorg-x11-server-utils` |
| zypper          | `zypper`        | openSUSE, SUSE Linux Enterprise                        | `weston` | `xvfb-run`                                      |
| pacman          | `pacman`        | Arch Linux, Manjaro, EndeavourOS, CachyOS, etc.        | `weston` | `xorg-server-xvfb`                              |
| apk             | `apk`           | Alpine Linux, PostmarketOS                             | `weston` | `xvfb-run`                                      |
| xbps-install    | `xbps-install`  | Void Linux                                             | `weston` | `xvfb-run`                                      |

With any other package manager the install fails, so install the display server yourself.

## Troubleshooting

- "No display server could be started; continuing without a virtual display"
  - No display server is installed, or none started. The warnings and errors before it show each server's output and any failed install.
  - Install `weston` or `xvfb` in your image, or set `displayServerAutoInstall: true`.

- Xvfb exits with "Failed to find a socket to listen on"
  - Xvfb creates its socket in `/tmp/.X11-unix`. If that directory exists, it must be writable by the test user, as mode `1777` is.

- Chrome fails to start under Weston
  - If you start the driver yourself, see [Drivers you start yourself](#drivers-you-start-yourself).
  - Otherwise, set `displayServer: 'xvfb'` to rule out Wayland.

- A display server starts although your CI provides one
  - The runner only checks `DISPLAY` and `WAYLAND_DISPLAY` in its own environment. Export the variable before WebdriverIO starts, or set `displayServerEnabled: false`.
