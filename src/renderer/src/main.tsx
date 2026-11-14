import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CaptureWindow from './components/CaptureWindow'
import ErrorBoundary from './components/ErrorBoundary'
import { applyTheme, readTheme } from './theme'

// Apply the saved theme before the first paint to avoid a light flash in dark mode.
applyTheme(readTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{location.hash === '#capture' ? <CaptureWindow /> : <App />}</ErrorBoundary>
  </StrictMode>
)
