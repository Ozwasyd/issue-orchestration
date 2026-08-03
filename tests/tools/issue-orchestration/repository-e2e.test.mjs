import test from 'node:test'
import { assertPermanentRepositoryE2E } from './e2e-test-helper.mjs'
test('permanent repository E2E', { timeout: 180000 }, assertPermanentRepositoryE2E)
