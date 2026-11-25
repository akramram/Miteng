// Hands the tab's audio to offscreen.js as mono Float32 blocks of 20 ms at 48 kHz.
const BLOCK = 960;

class MitengPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, BLOCK - this.filled);
      this.block.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === BLOCK) {
        this.port.postMessage(this.block.buffer, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('miteng-pcm', MitengPcm);
