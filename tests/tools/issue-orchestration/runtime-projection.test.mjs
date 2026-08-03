import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('runtime projection', () => assertPermanentLane('runtime-projection.test.mjs'))
