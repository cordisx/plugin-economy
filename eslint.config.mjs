import policy from '@cordisx/eslint-config'
import parser from '@typescript-eslint/parser'
export default [{ ignores: ['**/node_modules/**', '**/dist/**'] }, {
  files: ['**/*.{ts,tsx,js,mjs}'],
  ...policy,
  languageOptions: { parser },
}]
