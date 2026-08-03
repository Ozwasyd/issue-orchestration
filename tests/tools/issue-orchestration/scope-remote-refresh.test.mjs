import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('scope and remote refresh', () => assertPermanentLane('scope-remote-refresh.test.mjs'))
