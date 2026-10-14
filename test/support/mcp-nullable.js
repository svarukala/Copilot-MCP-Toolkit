export function nullableSearchTools() {
  return { tools: [{
    name: 'search_reference',
    description: 'Search public documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        include_domains: { type: 'array', items: { type: 'string' }, maxItems: 1 },
        search_depth: { type: 'string', enum: ['basic'] },
        max_results: { type: 'integer', minimum: 1, maximum: 1 },
        exact_match: { anyOf: [{ type: 'boolean' }, { type: 'null' }], default: null },
        time_range: { anyOf: [{ type: 'string', enum: ['day', 'week', 'month', 'year'] }, { type: 'null' }], default: null },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }] };
}

export function nullableSearchArguments() {
  return { query: 'Public documentation', include_domains: ['learn.microsoft.com'], search_depth: 'basic', max_results: 1 };
}
export function tavilyQualificationTools() {
  const tools = nullableSearchTools();
  tools.tools[0].name = 'tavily_search';
  for (const name of ['include_images', 'include_image_descriptions', 'include_favicon', 'include_raw_content']) {
    tools.tools[0].inputSchema.properties[name] = { type: 'boolean', default: false };
  }
  return tools;
}
export function tavilyQualificationArguments() {
  return { ...nullableSearchArguments(), query: 'Microsoft Learn Azure API Management MCP',
    include_images: false, include_image_descriptions: false, include_favicon: false, include_raw_content: false };
}
