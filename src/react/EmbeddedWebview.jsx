// Renders a real, live web page (Gmail/WhatsApp/Slack) inside the app's own
// layout - a plain empty div here is really a window onto a native child
// webview Rust positions to match it exactly (src-tauri/src/
// embedded_webview.rs). Polling every 500ms (not just a resize listener)
// catches layout shifts a resize event wouldn't - e.g. the sidebar
// collapsing, or switching tabs within Client Comms - at the cost of being
// a cheap, known-imperfect approximation rather than a true layout
// observer; acceptable for how static this app's own chrome is.
import * as React from 'react';
import { useEffect, useRef } from 'react';

export default function EmbeddedWebview({ label, url, initScript }) {
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let intervalId = null;

    async function sync() {
      if (cancelled) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      // Physical pixels, not logical - passed straight through to Rust's
      // PhysicalPosition/PhysicalSize (src-tauri/src/embedded_webview.rs).
      // This machine's multi-monitor setup has an unusual virtual-desktop
      // layout, and Tauri's own logical<->physical conversion for this
      // "unstable" child-webview API is exactly the kind of thing that
      // could get it wrong there - computing physical pixels ourselves
      // removes that ambiguity entirely.
      const dpr = window.devicePixelRatio || 1;
      const { invoke } = await import('@tauri-apps/api/core');
      invoke('embed_webview', {
        label,
        url,
        x: rect.left * dpr,
        y: rect.top * dpr,
        width: rect.width * dpr,
        height: rect.height * dpr,
        initScript: initScript || null,
      }).catch(() => {});
    }

    sync();
    window.addEventListener('resize', sync);
    intervalId = setInterval(sync, 500);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', sync);
      if (intervalId) clearInterval(intervalId);
      import('@tauri-apps/api/core').then(({ invoke }) => invoke('hide_embedded_webview', { label }).catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, url]);

  return <div ref={containerRef} className="w-full h-full" />;
}
