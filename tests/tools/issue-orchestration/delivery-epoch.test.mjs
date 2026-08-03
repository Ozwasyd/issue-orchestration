import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('delivery epoch', () => assertPermanentLane('delivery-epoch.test.mjs'))
