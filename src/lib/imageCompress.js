// Client-side image compression (canvas-based) for user-supplied images -
// profile photos and client photos. Screenshots are compressed separately,
// on the Rust side at capture time (see src-tauri/), since re-encoding a
// full screen capture through a JS canvas would mean shipping the
// uncompressed bitmap across the Tauri IPC bridge first for no reason.
export function compressImage(file, { maxWidth = 640, maxHeight = 640, quality = 0.82, mime = 'image/jpeg', square = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (square) {
        // Center-crop to 1:1 first (podcast/album cover-art convention -
        // whatever shape someone uploads, the stored file is always a real
        // square, not just square-LOOKING via CSS cropping at display time),
        // then scale that square crop down to the target size.
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const size = Math.min(maxWidth, maxHeight, side);
        canvas.width = size; canvas.height = size;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      } else {
        let { width, height } = img;
        const scale = Math.min(1, maxWidth / width, maxHeight / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        canvas.width = width; canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
      }
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
