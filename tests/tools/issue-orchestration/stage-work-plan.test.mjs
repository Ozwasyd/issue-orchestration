import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('stage work plan', () => assertPermanentLane('stage-work-plan.test.mjs'))
