import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('test contract stage liveness', () => assertPermanentLane('test-contract-liveness.test.mjs'))
