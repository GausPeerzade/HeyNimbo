// Converts microphone samples to PCM16 and posts 40 ms chunks (960 samples at
// 24 kHz). A "flush" message posts the remainder, then "flushed".
const CHUNK = 960

class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(CHUNK)
    this.length = 0
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      if (this.length > 0) this.post(this.buffer.slice(0, this.length))
      this.length = 0
      this.port.postMessage('flushed')
    }
  }

  post(samples) {
    this.port.postMessage(samples.buffer, [samples.buffer])
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]))
      this.buffer[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      if (this.length === CHUNK) {
        this.post(this.buffer)
        this.buffer = new Int16Array(CHUNK)
        this.length = 0
      }
    }
    return true
  }
}

registerProcessor('pcm16-capture', Pcm16Capture)
