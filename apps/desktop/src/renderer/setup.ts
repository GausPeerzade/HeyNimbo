import type { HeyNimboSetupApi } from '../preload/setup'
import { PROVIDER_NAMES, type KeyProvider } from '../shared/providers'
declare global { interface Window { heynimboSetup: HeyNimboSetupApi } }
const form = document.getElementById('form') as HTMLFormElement
const input = document.getElementById('key') as HTMLInputElement
const save = document.getElementById('save') as HTMLButtonElement
const provider = document.getElementById('provider') as HTMLSelectElement
const status = document.getElementById('status') as HTMLParagraphElement
provider.onchange = () => {
  input.value = ''; status.textContent = ''
  input.hidden = provider.value === 'chatgpt'; document.getElementById('key-label')!.hidden = input.hidden
  save.textContent = input.hidden ? 'Continue with ChatGPT' : `Connect ${PROVIDER_NAMES[provider.value as KeyProvider]}`
  document.getElementById('features')!.textContent = input.hidden ? 'Use your eligible Plus or Pro plan for answers at no charge from HeyNimbo. Voice needs a separate OpenAI API key.' : 'Your key is saved only on this Mac, in a file only your user account can read; it is sent only to its provider. API requests are billed to your account. An OpenAI key enables voice with any answer provider.'
}
document.getElementById('more')!.onclick = () => { void window.heynimboSetup.connect({ kind: 'settings' }) }
form.addEventListener('submit', event => {
  event.preventDefault(); save.disabled = true; status.className = ''
  status.textContent = provider.value === 'chatgpt' ? 'Finish signing in in your system browser…' : 'Testing the key…'
  const key = input.value; input.value = ''
  void window.heynimboSetup.connect(provider.value === 'chatgpt' ? { kind: 'signIn' } : { kind: 'saveKey', provider: provider.value as KeyProvider, key }).then(result => {
    status.className = result.ok ? 'ok' : 'error'; status.textContent = result.message
  }).catch(() => { status.className = 'error'; status.textContent = 'Could not connect. Try again in Settings → Connection.' }).finally(() => { save.disabled = false })
})
