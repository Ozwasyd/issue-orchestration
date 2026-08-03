import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('transition ledger', () => assertPermanentLane('transition-ledger.test.mjs'))
