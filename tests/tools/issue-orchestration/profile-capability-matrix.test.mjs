import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('profile capability matrix', () => assertPermanentLane('profile-capability-matrix.test.mjs'))
