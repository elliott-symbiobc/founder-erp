"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** An anchored panel that is not trapped inside the card that opened it.
 *
 *  The analyses module had two of these written inline — w-[26rem] and
 *  w-[34rem], absolutely positioned inside a grid cell. Both clipped against
 *  the card, neither closed on a click outside or on Escape, and one opened on
 *  hover only, so it could not be read on a touch device at all.
 *
 *  Portalling to <body> is what fixes the clipping: an absolutely positioned
 *  child is still bound by any ancestor that scrolls or hides its overflow,
 *  and a card grid has several. Position is measured from the trigger and
 *  re-measured on scroll and resize, since a fixed panel does not follow its
 *  anchor on its own.
 */
export default function Popover({
  trigger,
  children,
  align = "left",
  width = 380,
  label,
  onOpenChange,
}: {
  trigger: (p: { open: boolean; toggle: () => void; ref: React.Ref<any> }) => React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  width?: number;
  label?: string;
  /** Fired when the panel opens or closes. Lets a caller defer the fetch for
   *  its contents until someone actually asks to see them, without the caller
   *  having to set state while rendering the trigger. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLElement | null>(null);
  const notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  const panel = useRef<HTMLDivElement | null>(null);

  // Measured after paint, before the browser shows the frame — measuring in a
  // plain effect lets the panel render at 0,0 for one frame and jump.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      // Clamped to the viewport so a trigger near the right edge does not put
      // half the panel off screen — the failure the fixed w-[34rem] had.
      const raw = align === "right" ? r.right - width : r.left;
      const left = Math.min(Math.max(8, raw), window.innerWidth - width - 8);
      setPos({ top: r.bottom + 6, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, width]);

  useEffect(() => { notify.current?.(open); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    // Capture phase: a click handler inside a card that stops propagation
    // would otherwise keep the panel open forever.
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open]);

  return (
    <>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: anchor })}
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          style={{ top: pos.top, left: pos.left, width }}
          className="fixed z-50 max-h-[70vh] overflow-y-auto border border-gray-300
                     bg-white text-left shadow-xl dark:border-gray-600
                     dark:bg-gray-900"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
