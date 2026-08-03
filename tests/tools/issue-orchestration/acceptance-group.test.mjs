import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('acceptance group', () => assertPermanentLane('acceptance-group.test.mjs'))
