// JSON Schema for the input scene manifest (scene.json).
// `npm run schema` writes it to packages/core/schema/scene.schema.json for editors.

const size = { type: 'string', pattern: '^\\d+[xX]\\d+$', description: 'Pixel size as WIDTHxHEIGHT, e.g. 768x432' };
const ratio = { type: 'string', pattern: '^\\d+(\\.\\d+)?[:/]\\d+(\\.\\d+)?$', description: 'Aspect ratio as W:H, e.g. 16:9' };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$', description: 'URL-safe identifier' };
const text = { type: 'string', maxLength: 20000 };

export const sceneSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://videomap.dev/schema/scene.schema.json',
  title: 'VideoMap scene',
  description: 'Input manifest for `vmap build`: the videos to show and how to lay them out.',
  type: 'object',
  required: ['videos'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    title: { type: 'string', maxLength: 500 },
    description: text,
    surface: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { enum: ['plane', 'cylinder', 'sphere'], default: 'plane' },
        arc: { type: 'number', exclusiveMinimum: 0, maximum: 360, description: 'Cylinder: degrees wrapped. Sphere: longitude span.' },
        latitudeBand: {
          type: 'array',
          prefixItems: [{ type: 'number', minimum: -89, maximum: 89 }, { type: 'number', minimum: -89, maximum: 89 }],
          minItems: 2,
          maxItems: 2,
          description: 'Sphere only: [south, north] latitude limits in degrees.',
        },
        view: { enum: ['inside', 'outside'] },
      },
    },
    preview: {
      type: 'object',
      additionalProperties: false,
      properties: {
        duration: { type: 'number', exclusiveMinimum: 0, maximum: 300, description: 'Loop length in seconds shared by every tile.' },
        fps: { type: 'integer', minimum: 1, maximum: 60 },
        startStrategy: { enum: ['auto', 'start'], description: '"auto" skips roughly the first 10% of long videos.' },
        loopShort: { type: 'boolean', description: 'Loop clips shorter than the preview duration (otherwise hold the last frame).' },
      },
    },
    layout: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cellAspect: ratio,
        aspect: { ...ratio, description: 'Overall wall aspect when output.canvas is not set.' },
        fit: { enum: ['cover', 'contain'] },
        groupBy: { type: 'string', pattern: '^(none|category|tag:.+|meta\\..+)$' },
        sortBy: {
          type: 'array',
          items: { type: 'string', pattern: '^-?(id|title|duration|category|src|meta\\..+)$' },
        },
        groupGap: { type: 'integer', minimum: 0, maximum: 10 },
        labels: { type: 'boolean' },
      },
    },
    output: {
      type: 'object',
      additionalProperties: false,
      properties: {
        canvas: { anyOf: [size, { type: 'null' }], description: 'Full-resolution wall size; the cell size is derived from it.' },
        cell: { anyOf: [size, { type: 'null' }], description: 'Size of one video at full zoom; alternative to canvas.' },
        tile: size,
        tileCrf: { type: 'integer', minimum: 10, maximum: 51 },
        tileCodecs: {
          type: 'array',
          items: { enum: ['h264', 'vp9'] },
          minItems: 1,
          uniqueItems: true,
          description: 'Tile codecs in order of preference; the viewer plays the first one the browser supports. H.264 plays everywhere.',
        },
        background: color,
        stills: { type: 'boolean' },
        full: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            maxHeight: { type: 'integer', minimum: 144, maximum: 4320 },
            crf: { type: 'integer', minimum: 10, maximum: 51 },
          },
        },
      },
    },
    categories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: { id, label: { type: 'string' }, color, description: text },
      },
    },
    videos: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['src'],
        additionalProperties: false,
        properties: {
          id,
          src: { type: 'string', minLength: 1, description: 'Path relative to the scene file, or an http(s) URL.' },
          title: { type: 'string', maxLength: 500 },
          description: text,
          categories: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          previewStart: { type: 'number', minimum: 0 },
          poster: { type: 'string' },
          credits: {
            type: 'object',
            additionalProperties: false,
            properties: { author: { type: 'string' }, license: { type: 'string' }, url: { type: 'string' } },
          },
          links: {
            type: 'array',
            items: {
              type: 'object',
              required: ['href'],
              additionalProperties: false,
              properties: { label: { type: 'string' }, href: { type: 'string' } },
            },
          },
          meta: { type: 'object' },
        },
      },
    },
  },
};
