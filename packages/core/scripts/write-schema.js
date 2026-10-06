// Writes the scene JSON Schema to packages/core/schema/scene.schema.json.
import { writeFileSync } from 'node:fs';
import { sceneSchema } from '../src/schema.js';

const dest = new URL('../schema/scene.schema.json', import.meta.url);
writeFileSync(dest, `${JSON.stringify(sceneSchema, null, 2)}\n`);
console.log(`Wrote ${dest.pathname}`);
