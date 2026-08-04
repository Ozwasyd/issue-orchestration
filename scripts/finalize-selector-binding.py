from __future__ import annotations

import re
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count == 0:
        if new in text:
            return text
        raise SystemExit(f"missing {label}")
    if count != 1:
        raise SystemExit(f"ambiguous {label}: {count}")
    return text.replace(old, new, 1)


def regex_replace_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count == 0:
        raise SystemExit(f"missing {label}")
    return updated


compiler_path = Path(
    "skills/issue-orchestration/scripts/lifecycle-transition-compiler.mjs"
)
compiler = compiler_path.read_text()

legacy_validation = """    const legacySelector = selector.schema ===
        'issue-orchestration.scope-selector-receipt.v1' &&
        selector.status === 'verified'
    const productionSelector = selector.schema ===
        'issue-orchestration.selector-receipt.v1'
    if (!legacySelector && !productionSelector) {
        fail('lifecycle-selector-invalid')
    }
    if (productionSelector) {
        try {
            verifySelectorReceipt(selector)
        } catch (error) {
            fail('lifecycle-selector-invalid', {
                cause: error?.code ?? error?.message
            })
        }
    }
"""
canonical_validation = """    try {
        verifySelectorReceipt(selector)
    } catch (error) {
        fail('lifecycle-selector-invalid', {
            cause: error?.code ?? error?.message
        })
    }
"""
compiler = replace_once(
    compiler,
    legacy_validation,
    canonical_validation,
    "canonical selector validation",
)

canonical_remote_adapter = """export function compileLifecycleRemoteSnapshotReceipt(selectorReceipt) {
    let selector
    try {
        selector = verifySelectorReceipt(selectorReceipt)
    } catch (error) {
        fail('lifecycle-selector-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    requireDigest(
        selector.receiptDigest,
        'lifecycle-selector-digest-invalid'
    )
    requireDigest(
        selector.remoteSnapshotDigest,
        'lifecycle-selector-remote-invalid'
    )
    return Object.freeze({
        schema: 'issue-orchestration.remote-snapshot-receipt.v1',
        status: 'verified',
        selectorReceiptDigest: selector.receiptDigest,
        receiptDigest: selector.remoteSnapshotDigest
    })
}

"""
compiler = regex_replace_once(
    compiler,
    r"export function compileLifecycleRemoteSnapshotReceipt\(selectorReceipt\) \{.*?\n\}\n\n(?=export function compileLifecycleActionSet)",
    canonical_remote_adapter,
    "canonical remote snapshot adapter",
)
if "scope-selector-receipt.v1" in compiler:
    raise SystemExit("legacy selector authority remains in production compiler")
compiler_path.write_text(compiler)


harness_path = Path(
    "tests/tools/issue-orchestration/multi-repository-lifecycle-e2e.mjs"
)
harness = harness_path.read_text()
harness = replace_once(
    harness,
    """import {
    compileLifecycleActionSet as compileProductionLifecycleActionSet,
    validateLifecycleActionSet
} from '../../../skills/issue-orchestration/scripts/lifecycle-transition-compiler.mjs'
""",
    """import {
    compileLifecycleActionSet,
    compileLifecycleRemoteSnapshotReceipt,
    validateLifecycleActionSet
} from '../../../skills/issue-orchestration/scripts/lifecycle-transition-compiler.mjs'
""",
    "E2E production compiler import",
)
harness = regex_replace_once(
    harness,
    r"function compileLifecycleRemoteSnapshotReceipt\(selectorReceipt\) \{.*?\n\}\n\nfunction compileLifecycleActionSet\(input\) \{.*?\n\}\n\n(?=function selectorCanonical)",
    "",
    "E2E selector facade removal",
)
for forbidden in (
    "compileProductionLifecycleActionSet",
    "scope-selector-receipt.v1",
):
    if forbidden in harness:
        raise SystemExit(f"legacy E2E selector facade remains: {forbidden}")
harness_path.write_text(harness)


unit_path = Path("tests/tools/issue-orchestration-lifecycle-transition.test.mjs")
unit = unit_path.read_text()
fixture_anchor = "const remoteDigest = sha('remote')\n"
canonical_fixture = """const remoteDigest = sha('remote')
const canonicalSelectorReceipt = (() => {
    const receipt = {
        schema: 'issue-orchestration.selector-receipt.v1',
        startupAttestationDigest: sha('startup-attestation'),
        runtimeInvocationId: 'lifecycle-test-invocation',
        runtimeSessionId: 'lifecycle-test-session',
        selectorVersion: 'lifecycle-test-selector-v1',
        type: 'explicit-issues',
        parametersDigest: sha('selector-parameters'),
        selectorDigest,
        resolvedIssueSet: [],
        exclusionReasons: {},
        remoteQueryIdentity: 'lifecycle-test:explicit-issues',
        previousRemoteSnapshotDigest: null,
        remoteSnapshotDigest: remoteDigest,
        remoteFactDigests: {},
        remoteChangeSet: {
            added: [], changed: [], closed: [], removed: [], reopened: []
        },
        issueHistory: {},
        issueStates: {},
        resolvedAt: '2026-08-04T00:00:00.000Z'
    }
    receipt.receiptDigest = digest(receipt)
    return Object.freeze(receipt)
})()
const selectorReceiptDigest = canonicalSelectorReceipt.receiptDigest
"""
if "const canonicalSelectorReceipt = (() =>" not in unit:
    unit = replace_once(
        unit,
        fixture_anchor,
        canonical_fixture,
        "canonical selector unit fixture",
    )
unit = unit.replace("selectorReceiptDigest: selectorDigest", "selectorReceiptDigest")
unit = regex_replace_once(
    unit,
    r"        selectorReceipt: \{\n            schema: 'issue-orchestration\.scope-selector-receipt\.v1',\n            status: 'verified',\n            receiptDigest: selectorDigest,\n            remoteSnapshotDigest: remoteDigest\n        \},\n        remoteSnapshotReceipt: \{\n            schema: 'issue-orchestration\.remote-snapshot-receipt\.v1',\n            status: 'verified',\n            receiptDigest: remoteDigest\n        \},",
    """        selectorReceipt: structuredClone(canonicalSelectorReceipt),
        remoteSnapshotReceipt: {
            schema: 'issue-orchestration.remote-snapshot-receipt.v1',
            status: 'verified',
            selectorReceiptDigest,
            receiptDigest: remoteDigest
        },""",
    "canonical lifecycle compiler input",
)
if "scope-selector-receipt.v1" in unit:
    raise SystemExit("legacy selector schema remains in lifecycle unit tests")
unit_path.write_text(unit)


e2e_test_path = Path(
    "tests/tools/issue-orchestration-multi-repository-lifecycle-e2e.test.mjs"
)
e2e_test = e2e_test_path.read_text()
e2e_test = e2e_test.replace(
    "assert.match(runtimeSource, /compileProductionLifecycleActionSet/u)",
    "assert.match(runtimeSource, /compileLifecycleActionSet/u)\n"
    "    assert.match(runtimeSource, /compileLifecycleRemoteSnapshotReceipt/u)",
)
source_guard_anchor = """    assert.doesNotMatch(
        runtimeSource,
        /tests\\/fixtures|test-helper|fixture-only-constructor/iu
    )
"""
source_guard = source_guard_anchor + """    assert.doesNotMatch(
        runtimeSource,
        /scope-selector-receipt\\.v1|compileProductionLifecycleActionSet/u
    )
"""
if "scope-selector-receipt\\.v1|compileProductionLifecycleActionSet" not in e2e_test:
    e2e_test = replace_once(
        e2e_test,
        source_guard_anchor,
        source_guard,
        "E2E legacy selector source guard",
    )
e2e_test_path.write_text(e2e_test)
