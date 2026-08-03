import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('UI system adjudication', () => assertPermanentLane('ui-system-adjudication.test.mjs'))
