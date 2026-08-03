import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('landing lane', () => assertPermanentLane('landing-lane.test.mjs'))
