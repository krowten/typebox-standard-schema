import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	GOOGLE_SITE_VERIFICATION: {
		description:
			'Google Search Console verification token (the content of its HTML meta tag); set as a repository variable for the docs deploy',
		public: true,
		// inlined at build time: the docs site is static, there is no runtime to read it at
		static: true,
		schema: (value) => value || undefined
	}
});
