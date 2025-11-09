class PCMDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / 16000; // 48k -> 16k
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];

    const step = this._ratio;
    const outLen = Math.floor(ch0.length / step);
    const out = new Int16Array(outLen);

    let o = 0;
    for (let i=0; i<ch0.length; i+=step) {
      const s = Math.max(-1, Math.min(1, ch0[Math.floor(i)]));
      out[o++] = (s * 32767) | 0;
    }

    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}
registerProcessor('pcm-downsampler', PCMDownsampler);
