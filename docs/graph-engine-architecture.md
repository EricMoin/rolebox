# Graph engine architecture

The current architecture, tool vocabulary, persistence model, recovery rules, and platform limits are documented in [Graph engine v3](graph-outcome-protocol.md).

- [Operator configuration](graph-v3-operations.md)
- [Implementation and acceptance record](graph-v3-execution-plan.md)

Graph definitions use `graph_declare` with `version: 3`; workers settle declared outcomes through `graph_submit_outcome`, and authorized principals issue lifecycle commands through `graph_control`. There are no incremental node/edge construction tools or signal-driven graph execution paths. Shared function/observe signals retain their separate semantics.
