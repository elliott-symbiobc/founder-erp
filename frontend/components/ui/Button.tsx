"use client";

import { forwardRef } from "react";

/** The one small set of button shapes the app needs.
 *
 *  Written because the analyses module had grown nine of them by hand — a
 *  filled blue rect, three weights of bordered mini-button, and five bare
 *  lowercase text links — often three inside a single card. A reader cannot
 *  learn what is clickable when every control argues its own case.
 *
 *  Vocabulary is the house one on purpose: bg-blue-600 is the brand red after
 *  the remap in globals.css, and bg-white is warm paper. Nothing here invents
 *  a colour the rest of the app does not already use.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  // The one filled control on a screen. More than one and neither is primary.
  primary:
    "bg-blue-600 text-white hover:bg-blue-700 " +
    "disabled:hover:bg-blue-600",
  // The default. Carries the page's border weight, so a row of them reads as
  // one group rather than as a ransom note.
  secondary:
    "border border-gray-300 bg-white text-gray-700 hover:border-gray-500 " +
    "hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 " +
    "dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-800",
  // For the "close", "reset", "show code" class of action — quiet, but still
  // a button, so it keeps a hit area and a focus ring instead of being a word.
  ghost:
    "text-gray-500 hover:bg-gray-100 hover:text-gray-900 " +
    "dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100",
  // Destructive intent is stated on hover rather than at rest: a Delete that
  // is red before you reach for it makes every card look like a warning.
  danger:
    "border border-gray-200 text-gray-500 hover:border-red-400 " +
    "hover:bg-red-50 hover:text-red-700 dark:border-gray-700 " +
    "dark:text-gray-400 dark:hover:bg-red-950/40 dark:hover:text-red-300",
};

const SIZE: Record<Size, string> = {
  sm: "h-6 gap-1 px-2 text-2xs",
  md: "h-7 gap-1.5 px-2.5 text-xs",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "sm", className = "", type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={
        "inline-flex shrink-0 items-center justify-center font-medium " +
        "transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
        `${SIZE[size]} ${VARIANT[variant]} ${className}`
      }
      {...rest}
    />
  );
});

export default Button;

/** The same shapes for an <a>. Downloads and JupyterLab links are navigation,
 *  not actions, so they stay anchors — right-click and middle-click have to
 *  keep working. */
export function LinkButton({
  variant = "secondary",
  size = "sm",
  className = "",
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: Variant;
  size?: Size;
}) {
  return (
    <a
      className={
        "inline-flex shrink-0 items-center justify-center font-medium " +
        `transition-colors ${SIZE[size]} ${VARIANT[variant]} ${className}`
      }
      {...rest}
    />
  );
}
