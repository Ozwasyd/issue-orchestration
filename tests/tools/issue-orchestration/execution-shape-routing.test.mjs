import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('execution shape routing', () => assertPermanentLane('execution-shape-routing.test.mjs'))
