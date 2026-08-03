import test from 'node:test'
import { assertPermanentLane } from './e2e-test-helper.mjs'
test('DAG classification routing', () => assertPermanentLane('dag-classification-routing.test.mjs'))
