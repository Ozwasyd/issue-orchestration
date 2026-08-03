import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('human decision gate', () => assertPermanentLane('human-decision-gate.test.mjs'))
