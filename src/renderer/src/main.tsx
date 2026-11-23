import { createRoot } from 'react-dom/client'
import { App } from './App'
import { QuickBar } from './QuickBar'
import './styles.css'

const quick = location.hash === '#quick'
document.documentElement.classList.toggle('is-quick', quick)
createRoot(document.getElementById('root')!).render(quick ? <QuickBar /> : <App />)
