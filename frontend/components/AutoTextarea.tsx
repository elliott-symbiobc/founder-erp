"use client";

import React, { useEffect, useLayoutEffect, useRef } from "react";

/**
 * The platform textarea. Sized to whatever is in it, so nothing has to be
 * dragged open to read the end of a sentence.
 *
 * A drop-in replacement for `<textarea>`: same props, same styling hooks, so a
 * call site only changes its tag name. `rows` keeps working, but as a floor
 * rather than a fixed size — a box never renders shorter than the rows it asked
 * for, and grows past them as the text does.
 *
 * Measuring happens before paint (useLayoutEffect), otherwise a box holding
 * loaded text would flash at one line and jump to full height. It re-measures
 * on window resize too, since the same text needs more lines in a narrower box.
 *
 * `autoGrow={false}` opts out, for the handful of places where the height is
 * the layout's decision rather than the text's — a full-height editor pane, or
 * a box that flexes to fill a column.
 */

// SSR has no layout to measure; useEffect there keeps React from warning.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  autoGrow?: boolean;
};

export const AutoTextarea = React.forwardRef<HTMLTextAreaElement, Props>(
  function AutoTextarea({ autoGrow = true, rows, value, className, ...rest }, forwarded) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    // The caller may want the node too; keep both pointing at it.
    const setRef = (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof forwarded === "function") forwarded(node);
      else if (forwarded) forwarded.current = node;
    };

    useIsomorphicLayoutEffect(() => {
      const el = innerRef.current;
      if (!el || !autoGrow) return;

      const fit = () => {
        // Collapse first: scrollHeight only shrinks back if the box is not
        // already holding itself open at the taller size.
        el.style.height = "auto";
        el.style.overflowY = "hidden";
        const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
        const padding = el.offsetHeight - el.clientHeight;
        const floor = rows ? rows * line + padding : 0;
        el.style.height = `${Math.max(el.scrollHeight, floor)}px`;
        // A caller's max-height wins over growing — a chat box capped at a few
        // lines must still scroll, or everything past the cap is unreachable.
        if (el.scrollHeight > el.clientHeight) el.style.overflowY = "auto";
      };

      fit();
      window.addEventListener("resize", fit);
      return () => window.removeEventListener("resize", fit);
    }, [value, rows, autoGrow]);

    return (
      // overflow is set on the element as it is measured, not through a class,
      // so a caller's own overflow rules are never silently overwritten.
      <textarea ref={setRef} rows={rows} value={value} className={className} {...rest} />
    );
  },
);

export default AutoTextarea;
