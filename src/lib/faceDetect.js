// Client-side face detection for the forced signup profile photo - runs
// fully on-device (no server round trip, no extra cost). Model weights load
// lazily from jsdelivr's CDN the first time this is used (a few hundred KB,
// cached by the browser/webview after that) rather than being bundled into
// the app, since they're binary weight files that don't belong in source
// control the same way code does.
let faceapi = null;
let modelsReady = null;

async function ensureModels() {
  if (modelsReady) return modelsReady;
  modelsReady = (async () => {
    faceapi = await import('@vladmandic/face-api');
    const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  })();
  return modelsReady;
}

// Returns true if at least one face is detected in the given image File.
// Fails OPEN (returns true) if the model can't load at all - e.g. no
// internet on first run - so a flaky connection never blocks signup
// outright; it just skips the check that one time.
export async function imageHasFace(file) {
  try {
    await ensureModels();
    const img = await fileToImage(file);
    const result = await faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }));
    return !!result;
  } catch (err) {
    console.warn('[blue-kite-ops] face detection unavailable, skipping check:', err);
    return true;
  }
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
