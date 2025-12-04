class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data === 'stop') {
        this.stop = true;
      }
    };
    this.stop = false;
  }

  process(inputs, outputs, parameters) {
    if (this.stop) {
      return false;
    }

    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      if (channelData && channelData.length > 0) {
        const samples = Array.from(channelData);
        
        let rms = 0;
        if (samples.length > 0) {
          const sumSq = samples.reduce((sum, s) => sum + s * s, 0);
          rms = Math.sqrt(sumSq / samples.length);
        }

        this.port.postMessage({
          samples: samples,
          rms: rms,
          sampleCount: samples.length
        });
      }
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);

