/** One per directory under `src/routes/(docs)/`, so `resolve()` can type-check every link. */
export type DocSlug =
	| 'introduction'
	| 'getting-started'
	| 'projections'
	| 'composing'
	| 'recursive'
	| 'validation'
	| 'custom-formats'
	| 'adopting'
	| 'integrations'
	| 'json-schema'
	| 'comparison'
	| 'api';

export type NavItem = {
	title: string;
	slug: DocSlug;
	/** `<title>` for the page; falls back to `title`. Written for search results, not the sidebar. */
	headTitle?: string;
	/** Meta description, at most ~155 characters. */
	description: string;
};
export type NavGroup = { title: string; items: NavItem[] };

/** Sidebar structure — also drives prev/next links, page titles, meta descriptions and the sitemap. */
export const nav: NavGroup[] = [
	{
		title: 'Guide',
		items: [
			{
				title: 'Introduction',
				slug: 'introduction',
				headTitle: 'What Is Standard Schema? TypeBox Support',
				description:
					'Standard Schema is the ~standard interface shared by Zod, Valibot and ArkType. See how typebox-standard-schema brings it to every TypeBox 1.x schema.'
			},
			{
				title: 'Getting started',
				slug: 'getting-started',
				headTitle: 'Install TypeBox Standard Schema',
				description:
					'Install typebox-standard-schema, build a TypeBox schema and validate it through the Standard Schema interface in a few minutes, with Bun or Node.'
			},
			{
				title: 'Projections',
				slug: 'projections',
				headTitle: 'TypeBox readOnly writeOnly Schemas',
				description:
					'Derive request and response schemas from one TypeBox schema: Type.Read drops writeOnly fields like password, Type.Write drops readOnly ones like id.'
			},
			{
				title: 'Composing schemas',
				slug: 'composing',
				headTitle: 'Composing TypeBox schemas by value',
				description:
					'Nest TypeBox schemas by value to keep every tree self-contained, with projections and static types flowing through and $id names surviving.'
			},
			{
				title: 'Recursive schemas',
				slug: 'recursive',
				headTitle: 'Recursive TypeBox schemas with Type.Cyclic',
				description:
					'Model trees and other recursive types with Type.Cyclic: definitions live in the schema’s own $defs, so it stays self-contained and fully typed.'
			},
			{
				title: 'Validation',
				slug: 'validation',
				headTitle: 'TypeBox Validation and Coercion',
				description:
					'Validate with TypeBox and get coerced values, applied defaults and projection-stripped data back, with flat form-ready issues and a Standard Schema API.'
			},
			{
				title: 'Custom formats and types',
				slug: 'custom-formats',
				headTitle: 'Custom TypeBox formats and Type.Unsafe',
				description:
					'Register your own string formats with the Format registry and add custom schema nodes with Type.Unsafe while keeping static types and ~standard.'
			},
			{
				title: 'Adopting external schemas',
				slug: 'adopting',
				headTitle: 'Drizzle TypeBox as Standard Schema',
				description:
					'Wrap drizzle-typebox schemas, or any TypeBox-compatible schema, as Standard Schema validators with adopt() and project Read/Write shapes from tables.'
			}
		]
	},
	{
		title: 'Ecosystem',
		items: [
			{
				title: 'Framework integrations',
				slug: 'integrations',
				headTitle: 'TypeBox with tRPC, Hono, Elysia, SvelteKit',
				description:
					'Use TypeBox schemas in tRPC, Hono, Elysia, oRPC, h3, SvelteKit, TanStack Form, React Hook Form, next-safe-action, T3 Env and Nuxt UI, tested.'
			},
			{
				title: 'JSON Schema & OpenAPI',
				slug: 'json-schema',
				headTitle: 'TypeBox to OpenAPI and JSON Schema',
				description:
					'Emit draft 2020-12, draft-07 or OpenAPI 3.0 JSON Schema from TypeBox via Standard JSON Schema, for OpenAPI docs, AI SDK tools and MCP servers.'
			},
			{
				title: 'TypeBox vs Zod',
				slug: 'comparison',
				headTitle: 'TypeBox vs Zod, Valibot and ArkType',
				description:
					'TypeBox vs Zod, Valibot and ArkType once every library speaks Standard Schema: JSON Schema output, projections, ecosystem fit and when to pick which.'
			}
		]
	},
	{
		title: 'Reference',
		items: [
			{
				title: 'API reference',
				slug: 'api',
				headTitle: 'API reference',
				description:
					'Every export of typebox-standard-schema: Type, validate, parse, adopt, Format, Value and the projection and result types.'
			}
		]
	}
];

export const flat: NavItem[] = nav.flatMap((group) => group.items);

/**
 * Where a route sits in the docs. Takes the route id rather than the URL pathname: the id is
 * the same during prerendering and in the browser, whereas a pathname carries the deploy base
 * path (and `resolve('/')` turns into `./` under `paths.relative` while prerendering).
 */
export function findByRoute(routeId: string | null): {
	current: NavItem | undefined;
	prev: NavItem | undefined;
	next: NavItem | undefined;
} {
	const slug = routeId?.replace(/^\/\(docs\)\//, '');
	const index = flat.findIndex((item) => item.slug === slug);
	return {
		current: flat[index],
		prev: index > 0 ? flat[index - 1] : undefined,
		next: index >= 0 && index < flat.length - 1 ? flat[index + 1] : undefined
	};
}
