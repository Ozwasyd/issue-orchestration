import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'

test('reviewed routing assumptions', () =>
    assertPermanentLane('reviewed-routing-assumptions.test.mjs'))
