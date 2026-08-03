import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('progress checkpoint continuation', () => assertPermanentLane('progress-checkpoint-continuation.test.mjs'))
