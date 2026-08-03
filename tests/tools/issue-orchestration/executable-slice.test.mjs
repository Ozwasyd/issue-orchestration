import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('executable slice', () => assertPermanentLane('executable-slice.test.mjs'))
