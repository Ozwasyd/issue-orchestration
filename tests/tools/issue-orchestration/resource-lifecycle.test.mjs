import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('resource lifecycle', () => assertPermanentLane('resource-lifecycle.test.mjs'))
