import type { Metadata } from 'next'
import { Schibsted_Grotesk, Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './tokens.css'
import './globals.css'

/*
 * The lesson type stack (design/reference/tokens.css) — actually loaded and
 * self-hosted by next/font so the declared `--font-display`/`--font-ui`/
 * `--font-mono` faces resolve instead of silently falling back to system-ui.
 * Each instance exposes a CSS variable that tokens.css / the lesson shell wire
 * into the design tokens; `display: 'swap'` keeps first paint unblocked.
 */
const fontDisplay = Schibsted_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display-face',
})
const fontUi = Geist({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-ui-face',
})
const fontMono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono-face',
})

export const metadata: Metadata = {
  title: 'Medical Record Eval Sandbox',
  description: 'Eval harness for synthetic C-CDA patient records',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fontDisplay.variable} ${fontUi.variable} ${fontMono.variable}`}
    >
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
