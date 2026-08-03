import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('quiescence', () => assertPermanentLane('quiescence.test.mjs'))
