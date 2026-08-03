import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('remote mutation classification', () => assertPermanentLane('remote-mutation-classification.test.mjs'))
