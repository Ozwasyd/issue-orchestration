import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('semantic graph patch', () => assertPermanentLane('semantic-graph-patch.test.mjs'))
