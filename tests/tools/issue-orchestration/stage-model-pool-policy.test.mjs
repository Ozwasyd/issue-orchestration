import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('stage model pool policy', () => assertPermanentLane('stage-model-pool-policy.test.mjs'))
