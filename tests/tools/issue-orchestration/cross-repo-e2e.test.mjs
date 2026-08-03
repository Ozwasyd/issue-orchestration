import test from 'node:test'
import { assertPermanentCrossRepoE2E } from './e2e-test-helper.mjs'
test('permanent cross repository E2E', { timeout: 180000 }, assertPermanentCrossRepoE2E)
