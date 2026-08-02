import { createHash } from 'node:crypto'

export const HASH = /^[a-f0-9]{64}$/u

export class RuntimeContractError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'RuntimeContractError'
        this.code = code
        this.details = details
    }
}

export function fail(code, message = code, details = {}) {
    throw new RuntimeContractError(code, message, details)
}

export function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

export function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

export function unsignedDigest(value, field) {
    const copy = structuredClone(value)
    delete copy[field]
    return digest(copy)
}

export function seal(value, field) {
    const result = structuredClone(value)
    result[field] = digest(result)
    return Object.freeze(result)
}

export function sameValue(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

export function assertDigest(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

export function assertText(value, code) {
    if (typeof value !== 'string' || !value) fail(code)
}

export function assertArray(value, code, { min = 0 } = {}) {
    if (!Array.isArray(value) || value.length < min) fail(code)
    return value
}

export function uniqueSorted(values) {
    return [...new Set(values)].sort()
}
