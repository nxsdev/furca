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
