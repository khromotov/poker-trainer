import type { HandAdvice } from "./model";

/** A sampled winner must not be presented as a recommended action when the
 * model cannot distinguish it from the alternatives. Statistical separation
 * still does not validate the underlying strategic assumptions.
 */
export function presentEstimate(advice: HandAdvice | undefined) {
  if (!advice)
    return { state: "pending", color: "unknown", label: "Расчёт" } as const;
  if (
    advice.uncertain ||
    !Number.isFinite(advice.error) ||
    Object.values(advice.ev).some((ev) => !Number.isFinite(ev))
  ) {
    return {
      state: "inconclusive",
      color: "inconclusive",
      label: "Нет уверенного выбора",
    } as const;
  }
  return {
    state: "estimate",
    color: advice.action,
    label: "Оценка модели",
    action: advice.action,
    raiseTo: advice.raiseTo,
  } as const;
}
