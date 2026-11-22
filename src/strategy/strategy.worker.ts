import { solvePreflop, type ModelContext } from "./model";

// The UI owns worker termination when the state changes: stale results must not replace a newer matrix.
self.onmessage = (
  event: MessageEvent<{ id: string; context: ModelContext }>,
) => {
  const { id, context } = event.data;
  try {
    const result = solvePreflop(context, (progress) =>
      self.postMessage({ id, progress }),
    );
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
