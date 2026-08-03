import Ajv2020 from 'ajv/dist/2020.js';
import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function errorLocation(error)
{
    const path = error.instancePath || '/';
    const property = error.keyword === 'additionalProperties'
        ? `/${error.params.additionalProperty}`
        : '';
    return `${path}${property}`.replaceAll('//', '/');
}

export function validateJsonSchema(document, schema)
{
    const validator = new Ajv2020({
        allErrors: true,
        strict: true,
        strictRequired: false,
        validateFormats: false
    });
    const validate = validator.compile(schema);
    if (validate(document))
    {
        return [];
    }
    return (validate.errors ?? []).map((error) =>
        `${errorLocation(error)} ${error.message ?? error.keyword}`);
}

async function main()
{
    const schemaFile = process.argv[2];
    if (!schemaFile)
    {
        throw new Error('usage: node validate.mjs <schema-file>');
    }
    let source = '';
    for await (const chunk of process.stdin)
    {
        source += chunk;
    }
    const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    const document = JSON.parse(source);
    process.stdout.write(`${JSON.stringify(validateJsonSchema(document, schema))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    main().catch((error) =>
    {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
    });
}
