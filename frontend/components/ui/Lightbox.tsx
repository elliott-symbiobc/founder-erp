"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** A full-size view of one image, over the page.
 *
 *  Notebook figures arrive as data URIs at full resolution and were drawn into
 *  whatever width the step column happened to be — which for a plot with axis
 *  labels means it is present but not readable. Nothing needs fetching to show
 *  it properly; the pixels are already here.
 *
 *  Takes the whole list rather than one src, because a cell that draws a figure
 *  usually draws several and comparing them is the reason to open one.
 */
export default function Lightbox({ images, index, onClose, onIndex, label }: {
  images: string[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
  label?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const many = images.length > 1;

  const step = useCallback((by: number) => {
    onIndex((index + by + images.length) % images.length);
  }, [index, images.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (many && e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (many && e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    };
    document.addEventListener("keydown", onKey);
    // The page behind must not scroll under the overlay — a wheel gesture
    // meant for the figure otherwise moves the step list out from under it.
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, step, many]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label ?? "Figure"}
      // Closing on the backdrop is the gesture people try first. The image and
      // the controls stop the click, so only the surround dismisses.
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4
                 backdrop-blur-sm"
    >
      <div className="absolute right-3 top-3 flex items-center gap-2">
        {many && (
          <span className="bg-black/50 px-2 py-1 text-2xs text-white/80">
            {index + 1} of {images.length}
          </span>
        )}
        <button ref={closeRef} type="button" aria-label="Close"
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                className="bg-white/10 px-2.5 py-1 text-xs font-medium text-white
                           transition-colors hover:bg-white/25">
          Close
        </button>
      </div>

      {many && (
        <>
          <button type="button" aria-label="Previous figure"
                  onClick={(e) => { e.stopPropagation(); step(-1); }}
                  className="absolute left-3 px-3 py-6 text-xl text-white/70
                             transition-colors hover:text-white">
            ‹
          </button>
          <button type="button" aria-label="Next figure"
                  onClick={(e) => { e.stopPropagation(); step(1); }}
                  className="absolute right-3 px-3 py-6 text-xl text-white/70
                             transition-colors hover:text-white">
            ›
          </button>
        </>
      )}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={images[index]}
        alt={label ?? "Figure at full size"}
        onClick={(e) => e.stopPropagation()}
        // White ground: these are matplotlib figures with transparent
        // backgrounds, and black axis text on a dark backdrop is invisible.
        className="max-h-[90vh] max-w-[95vw] bg-white object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
}
