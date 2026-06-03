import { ApiKeyInput } from '@/components/ApiKeyInput'

export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px' }}>
      <h1>Medical Record Eval Sandbox</h1>
      <p>Load synthetic C-CDA patient records, write prompts, build golden sets, and run evals live.</p>
      <ApiKeyInput />
    </main>
  )
}
