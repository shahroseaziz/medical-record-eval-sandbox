import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  // design/ holds non-compilable UX reference prototypes (see design/reference/README.md)
  { ignores: ['design/**'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
]

export default eslintConfig
