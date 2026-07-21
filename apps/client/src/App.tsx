import { useState } from 'react'
import type { GameClient } from './store.ts'
import { GameClientProvider, Router } from './screens/router.tsx'
import { currentTheme, toggleTheme } from './theme.ts'
import './App.css'

function App({ client }: { client: GameClient }) {
  const [theme, setTheme] = useState(currentTheme)
  const other = theme === 'dark' ? 'light' : 'dark'
  return (
    <GameClientProvider client={client}>
      <button
        type="button"
        className="theme-toggle"
        data-testid="theme-toggle"
        title={`Switch to ${other} theme`}
        aria-label={`Switch to ${other} theme`}
        onClick={() => setTheme(toggleTheme())}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
      <Router />
    </GameClientProvider>
  )
}

export default App
