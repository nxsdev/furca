/**
 * Suggests a key (`[a-z0-9][a-z0-9_-]{0,63}`) from a display name. Accents fold to ASCII
 * ("Café" → "cafe"). A name with other letters (Japanese, Cyrillic…) gives "" instead of a
 * partial slug like "v2" from "購入 v2": the caller leaves the key for the user to type
 */
export const slugify = (name: string): string => {
  const folded = name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  if (/(?![a-z])\p{L}/u.test(folded)) return "";
  return folded
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
};

/**
 * A key for things whose key users rarely type themselves (experiments, metrics, saved groups):
 * the slug of the name, or for names with no ASCII slug (Japanese…) `<prefix>-` plus a short
 * hash of the name, stable while the name stays the same. "" for an empty name
 */
export const suggestKey = (name: string, prefix: string): string => {
  const trimmed = name.trim();
  if (trimmed === "") return "";
  const slug = slugify(trimmed);
  if (slug !== "") return slug;
  let h = 0x811c9dc5;
  for (const ch of trimmed) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return `${prefix}-${h.toString(36).padStart(7, "0").slice(0, 6)}`;
};
