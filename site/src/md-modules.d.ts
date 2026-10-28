// mdsvex compiles .md files into Svelte components
declare module '*.md' {
	import type { Component } from 'svelte';
	const component: Component;
	export default component;
}
