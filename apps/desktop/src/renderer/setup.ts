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
  void window.nimboSetup.saveOpenAIKey(input.value).then((result) => {
    save.disabled = false
    status.className = result.ok ? 'ok' : 'error'
    status.textContent = result.ok ? 'Saved. Hold Ctrl+Option and ask away.' : result.reason
    if (result.ok) input.value = ''
  })
})
