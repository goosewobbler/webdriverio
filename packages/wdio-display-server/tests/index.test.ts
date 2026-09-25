import { describe, it, expect } from 'vitest'

import * as displayServer from '../src/index.js'

describe('@wdio/display-server', () => {
    it('exports its public API', () => {
        expect(Object.keys(displayServer).sort()).toEqual([
            'DisplayServerManager',
            'WaylandDisplayServer',
            'XvfbDisplayServer',
            'optionsFromConfig',
            'startDisplayDaemonFromConfig',
        ])
    })
})
