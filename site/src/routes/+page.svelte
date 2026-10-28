<script lang="ts">
	import { resolve } from '$app/paths';
	import Hero from '#lib/snippets/hero.md';
	import Install from '#lib/snippets/install.md';
	import {
		AUTHOR,
		NPM_URL,
		OG_IMAGE,
		REPO_URL,
		SITE_URL,
		SITE_NAME,
		SITE_TITLE,
		SITE_DESCRIPTION
	} from '#lib/site.js';
	import PageMeta from '#lib/components/PageMeta.svelte';

	const jsonLd = [
		{
			'@context': 'https://schema.org',
			'@type': 'SoftwareSourceCode',
			name: SITE_NAME,
			description: SITE_DESCRIPTION,
			url: SITE_URL,
			image: OG_IMAGE.url,
			codeRepository: REPO_URL,
			programmingLanguage: 'TypeScript',
			runtimePlatform: ['Bun', 'Node.js'],
			license: 'https://opensource.org/licenses/MIT',
			author: AUTHOR,
			keywords: 'typebox, standard schema, standard json schema, json schema, openapi, validation, typescript, readOnly, writeOnly, trpc, hono, elysia'
		},
		{
			'@context': 'https://schema.org',
			'@type': 'WebSite',
			name: SITE_NAME,
			url: SITE_URL
		}
	];

	const features = [
		{
			title: 'Standard Schema out of the box',
			body: 'Every schema built via Type carries ~standard, so it plugs into tRPC, Hono, Elysia, TanStack Form, React Hook Form and SvelteKit remote functions, fully typed.'
		},
		{
			title: 'Read/write projections',
			body: 'Mark fields with Type.Readonly and Type.Writeonly, then derive input and output shapes, runtime and static types, with Type.Write and Type.Read.'
		},
		{
			title: 'JSON Schema and OpenAPI',
			body: 'Standard JSON Schema built in: draft 2020-12, draft-07 or OpenAPI 3.0 for docs generators, AI SDK tools and MCP servers, no converter needed.'
		},
		{
			title: 'Validation that fits forms',
			body: 'Coercion of form and query strings, defaults, PATCH-safe partial schemas and flat issues with a path per field. Your input is never mutated.'
		}
	];
</script>

<PageMeta
	title={SITE_TITLE}
	socialTitle="Standard Schema for TypeBox"
	description={SITE_DESCRIPTION}
	url={SITE_URL}
	type="website"
	{jsonLd}
/>

<section class="mx-auto max-w-[1152px] px-6 pt-20 pb-16 text-center">
	<h1
		class="mx-auto max-w-3xl text-5xl font-bold tracking-tight text-vp-fg-strong dark:text-vpd-fg"
	>
		<span class="text-brand">Standard Schema</span> for TypeBox
	</h1>
	<p class="mx-auto mt-5 max-w-2xl text-lg text-vp-fg-muted dark:text-vpd-fg-muted">
		Read and write projections from one schema: derive input and output shapes, validate forms with
		coercion and field-level errors, and plug into any Standard Schema consumer.
	</p>

	<div class="mt-8 flex justify-center gap-3">
		<a
			href={resolve('/(docs)/getting-started')}
			class="rounded-full bg-brand-solid px-6 py-2.5 font-medium text-white hover:bg-brand-solid-hover"
		>
			Get started
		</a>
		<a
			href={REPO_URL}
			target="_blank"
			rel="noreferrer"
			class="rounded-full border border-vp-divider px-6 py-2.5 font-medium text-vp-fg-strong hover:border-brand dark:border-vpd-divider dark:text-vpd-fg"
		>
			GitHub
		</a>
		<a
			href={NPM_URL}
			target="_blank"
			rel="noreferrer"
			class="hidden rounded-full border border-vp-divider px-6 py-2.5 font-medium text-vp-fg-strong hover:border-brand sm:block dark:border-vpd-divider dark:text-vpd-fg"
		>
			npm
		</a>
	</div>

	<div class="docs-prose mx-auto mt-10 max-w-md text-left"><Install /></div>

	<div class="docs-prose mx-auto mt-4 max-w-2xl text-left">
		<Hero />
	</div>
</section>

<section class="border-t border-vp-divider dark:border-vpd-divider">
	<div class="mx-auto grid max-w-[1152px] gap-4 px-6 py-14 sm:grid-cols-2">
		{#each features as feature (feature.title)}
			<div class="rounded-xl bg-vp-bg-soft p-6 dark:bg-vpd-bg-soft">
				<h2 class="font-semibold text-vp-fg-strong dark:text-vpd-fg">{feature.title}</h2>
				<p class="mt-2 text-sm leading-6 text-vp-fg-muted dark:text-vpd-fg-muted">
					{feature.body}
				</p>
			</div>
		{/each}
	</div>
</section>
