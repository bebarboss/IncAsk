// Files dropped on the window while a drop target is on screen (Tauri gives real paths; a browser
// does not, so in mock mode this is a no-op and the "เลือกไฟล์" button is used instead).
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

export function useFileDrop(onDrop: (path: string) => void, extensions: string[]): boolean {
  const [hover, setHover] = useState(false);
  const cb = useRef(onDrop);
  cb.current = onDrop;
  useEffect(() => {
    if (api.mock) return;
    let off: (() => void) | null = null;
    let alive = true;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") setHover(true);
        else if (p.type === "leave") setHover(false);
        else if (p.type === "drop") {
          setHover(false);
          const file = p.paths.find((x) => extensions.some((ext) => x.toLowerCase().endsWith(`.${ext}`)));
          if (file) cb.current(file);
        }
      }),
    ).then((f) => { if (alive) off = f; else f(); }).catch(() => {});
    return () => { alive = false; off?.(); };
  }, [extensions.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return hover;
}
