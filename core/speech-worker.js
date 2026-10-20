'use strict';
// Runs speech recognition on its own thread (it takes a second or two per commercial and would otherwise hold up
// everything else). Messages: { id, samples: Float32Array } → { id, text } or { id, error }.

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

let recognizer = null, failure = null;
try {
  const sherpa = require('sherpa-onnx-node');
  const dir = workerData.modelDir;
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: path.join(dir, 'encoder.onnx'), decoder: path.join(dir, 'decoder.onnx'), language: 'en', task: 'transcribe' },
      tokens: path.join(dir, 'tokens.txt'),
      numThreads: workerData.threads || 2,
      provider: 'cpu',
      debug: 0,
    },
  });
} catch (e) {
  failure = e.message;
}

parentPort.postMessage({ ready: !failure, error: failure });

parentPort.on('message', ({ id, samples }) => {
  if (failure) return parentPort.postMessage({ id, error: failure });
  try {
    // Whisper listens to at most 30 s at a time.
    const parts = [];
    const chunk = 16000 * 28;
    for (let off = 0; off < samples.length; off += chunk) {
      const piece = samples.subarray(off, Math.min(samples.length, off + chunk));
      if (piece.length < 16000 * 0.5) break;
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: piece, sampleRate: 16000 });
      recognizer.decode(stream);
      parts.push(recognizer.getResult(stream).text.trim());
    }
    parentPort.postMessage({ id, text: parts.join(' ').trim() });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
