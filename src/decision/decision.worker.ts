import type {
  ActionType,
  DecisionObservation,
  OpponentProfile,
} from "./engine";
import { analyzeDecision, chooseBotAction, gradeDecision } from "./policy";

export interface DecisionWorkerRequest {
  id: number | string;
  observation: DecisionObservation;
  mode: "analyze" | "bot" | "grade";
  seed: number;
  samples?: number;
  profile?: OpponentProfile;
  action?: ActionType;
  total?: number;
}

self.onmessage = (event: MessageEvent<DecisionWorkerRequest>) => {
  const { id, observation, mode, seed, samples, profile, action, total } =
    event.data;
  try {
    if (mode === "bot") {
      self.postMessage({
        id,
        action: chooseBotAction(observation, profile ?? "balanced", seed),
      });
    } else {
      const analysis = analyzeDecision(observation, { seed, samples, profile });
      self.postMessage({
        id,
        analysis,
        ...(mode === "grade" && action
          ? { feedback: gradeDecision(observation, analysis, action, total) }
          : {}),
      });
    }
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
