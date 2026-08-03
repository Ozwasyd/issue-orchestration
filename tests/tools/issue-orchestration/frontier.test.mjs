import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('frontier', () => assertPermanentLane('frontier.test.mjs'))
