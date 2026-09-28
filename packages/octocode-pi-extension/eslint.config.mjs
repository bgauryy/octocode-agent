import tseslint from 'typescript-eslint';

// Keep modules small: split a file before it outgrows these limits.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'themes/**', 'subagents/**'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
  },
  { files: ['src/**/*.ts'], rules: { 'max-lines': ['error', { max: 400 }] } },
  { files: ['tests/**/*.ts'], rules: { 'max-lines': ['error', { max: 600 }] } },
);
