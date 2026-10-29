import type { NimboSetupApi } from '../preload/setup'

declare global {
  interface Window {
    nimboSetup: NimboSetupApi
  }
}

const form = document.getElementById('form') as HTMLFormElement
const input = document.getElementById('key') as HTMLInputElement
const save = document.getElementById('save') as HTMLButtonElement
const status = document.getElementById('status') as HTMLParagraphElement

form.addEventListener('submit', (event) => {
  event.preventDefault()
  save.disabled = true
  status.className = ''
  status.textContent = 'Checking the key with OpenAI…'
  window.nimboSetup
    .saveOpenAIKey(input.value)
    .then((result) => {
      status.className = result.ok ? 'ok' : 'error'
      status.textContent = result.ok ? 'Connected. Hold Control + Option to speak.' : result.reason
      if (result.ok) input.value = ''
    })
    .catch(() => {
      status.className = 'error'
      status.textContent = 'Could not connect. Check your connection and try again.'
    })
    .finally(() => (save.disabled = false))
})
