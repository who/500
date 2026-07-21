import type { GameClient } from './store.ts'
import { GameClientProvider, Router } from './screens/router.tsx'
import './App.css'

function App({ client }: { client: GameClient }) {
  return (
    <GameClientProvider client={client}>
      <Router />
    </GameClientProvider>
  )
}

export default App
