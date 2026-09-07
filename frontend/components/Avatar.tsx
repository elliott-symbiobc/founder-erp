"use client";

/**
 * The platform avatar. One implementation for every place a person is shown —
 * project cards, CRM deals, milestones, the funding investor list and the
 * module-owner badge in the shell.
 *
 * This replaced six hand-rolled copies that had drifted apart (filled circles
 * vs neutral tiles, 9px vs 10px initials, white vs zinc text). Change the look
 * here and it changes everywhere.
 *
 * `size` is the Tailwind spacing scale the old copies used — 5 → 20px,
 * 7 → 28px — applied as an inline style rather than a `w-${size}` class, since
 * a dynamically built class name is not statically extractable by Tailwind and
 * only worked before by accident.
 */
export function Avatar({ name, url, size = 5, title }: {
  name?: string | null;
  url?: string | null;
  size?: number;
  title?: string;
}) {
  const px = size * 4;
  // Initials have to grow with the tile. A fixed 10px only ever looked right
  // because every early caller was 16-28px; at a 32px row avatar or an 80px
  // contact header it reads as a speck. Floored at 10 so the small sizes the
  // component already shipped with are untouched.
  const fontSize = Math.max(10, Math.round(px * 0.4));
  const box = { width: px, height: px, fontSize };

  if (url) {
    return (
      <img src={url} alt={name ?? ""} title={title} style={box}
        className="rounded object-cover flex-shrink-0" />
    );
  }

  const initials = (name ?? "")
    .trim().split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  // No name means nobody is assigned. A dashed outline reads as empty, where a
  // filled tile would look like a person whose initials failed to load.
  if (!initials) {
    return (
      <span title={title ?? "Unassigned"} style={box}
        className="inline-flex items-center justify-center rounded border border-dashed border-zinc-300 dark:border-zinc-600 font-bold text-zinc-300 dark:text-zinc-600 flex-shrink-0">
        ?
      </span>
    );
  }

  return (
    <span title={title} style={box}
      className="inline-flex items-center justify-center rounded bg-zinc-200 dark:bg-zinc-700 font-bold text-zinc-600 dark:text-zinc-300 flex-shrink-0">
      {initials}
    </span>
  );
}

export default Avatar;
