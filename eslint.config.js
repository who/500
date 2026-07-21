import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'apps/client/dist/**'],
  },
  ...tseslint.configs.recommended,
);
