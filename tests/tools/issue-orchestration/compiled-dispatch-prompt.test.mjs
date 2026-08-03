import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('compiled dispatch prompt', () => assertPermanentLane('compiled-dispatch-prompt.test.mjs'))
