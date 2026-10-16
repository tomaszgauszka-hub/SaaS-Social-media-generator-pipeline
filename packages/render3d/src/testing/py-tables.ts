/** Read closed-set tables out of the Python scene spec (tests keep the TS and Python vocabularies identical). */

export const ACTIONS_PY = "ACTIONS";

export function pyTuple(src: string, name: string): string[] {
  const m =
    new RegExp(`^${name} = \\(([^\\n]*)\\)$`, "m").exec(src) ??
    new RegExp(`^${name} = \\(([\\s\\S]*?)\\n\\)`, "m").exec(src);
  if (!m) throw new Error(`tuple ${name} not found`);
  return [...m[1]!.matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]!);
}

export function pyDictKeys(src: string, name: string): string[] {
  const m = new RegExp(`^${name} = \\{([\\s\\S]*?)\\n\\}`, "m").exec(src);
  if (!m) throw new Error(`dict ${name} not found`);
  return [...m[1]!.matchAll(/^\s+"([A-Za-z0-9_]+)":/gm)].map((x) => x[1]!);
}
