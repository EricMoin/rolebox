export type OutcomeStateProblem =

  | "state-plan-mismatch"

  | "unsupported-state-version"

  | "malformed-state";

export class OutcomeStateError extends Error {
  readonly problem: OutcomeStateProblem;

  constructor(problem: OutcomeStateProblem, message: string) {
    super(message);
    this.name = "OutcomeStateError";
    this.problem = problem;
  }
}

export function malformedState(detail: string): OutcomeStateError {
  return new OutcomeStateError(
    "malformed-state",
    "outcome-state: the persisted graph state is not the state this build writes: " +
    detail,
  );
}

