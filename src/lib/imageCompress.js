// Client-side image compression (canvas-based) for user-supplied images —
// profile photos and client photos. Screenshots are compressed separately,
// on the Rust side at capture time (see src-tauri/), since re-encoding a
// full screen capture through a JS canvas would mean shipping the
// uncompressed bitmap across the Tauri IPC bridge first for no reason.
export function compressImage(file, { maxWidth = 640, maxHeight = 640, quality = 0.82, mime = 'image/jpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxWidth / width, maxHeight / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('Could not compress image')); return; }
        resolve(blob);
      }, mime, quality);
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
