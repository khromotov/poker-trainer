/** A preflop type denotes 6 pair, 4 suited, or 12 offsuit card combinations. */
const RANKS = "AKQJT98765432";
export type HandType = string;
export function handAt(row: number, column: number): HandType {
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(column) ||
    row < 0 ||
    row > 12 ||
    column < 0 ||
    column > 12
  )
    throw Error("Некорректная ячейка");
  if (row === column) return RANKS[row] + RANKS[column];
  const high = RANKS[Math.min(row, column)],
    low = RANKS[Math.max(row, column)];
  return high + low + (row < column ? "s" : "o");
}
export const preflopMatrix = () =>
  Array.from({ length: 13 }, (_, r) =>
    Array.from({ length: 13 }, (_, c) => handAt(r, c)),
  );
export function combinationsFor(type: HandType): number {
  if (
    !/^(?:AA|KK|QQ|JJ|TT|99|88|77|66|55|44|33|22|[AKQJT98765432]{2}[so])$/.test(
      type,
    )
  )
    throw Error("Некорректная рука");
  if (type.length === 2) return 6;
  if (RANKS.indexOf(type[0]) >= RANKS.indexOf(type[1]))
    throw Error("Некорректный порядок рангов");
  return type[2] === "s" ? 4 : 12;
}
