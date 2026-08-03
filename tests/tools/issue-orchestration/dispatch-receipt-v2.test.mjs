import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('dispatch receipt v2', () => assertPermanentLane('dispatch-receipt-v2.test.mjs'))
