import { GenieScript } from 'genie-react/next'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { GenieQueryTools } from './genie-manual'
import './globals.css'

export const metadata: Metadata = {
  title: 'Genie Next.js Demo',
  description: 'Exercises Genie live DevTools against a Next.js App Router app',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <GenieScript />
        <GenieQueryTools />
        {children}
        <footer>Genie demo — Next.js App Router</footer>
      </body>
    </html>
  )
}
