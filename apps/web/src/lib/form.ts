/** FormData helpers for server actions (all values are validated with zod afterwards). */
export const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
export const optStr = (f: FormData, k: string) => str(f, k) || undefined;
export const bool = (f: FormData, k: string) => f.get(k) === "on" || f.get(k) === "true";
export const lines = (f: FormData, k: string) =>
  str(f, k)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
export const list = (f: FormData, k: string) =>
  str(f, k)
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);
export const all = (f: FormData, k: string) => f.getAll(k).filter((v): v is string => typeof v === "string");
/** "" → null (no limit), otherwise a non-negative number string */
export const money = (f: FormData, k: string) => {
  const v = str(f, k);
  return v === "" ? null : v;
};
