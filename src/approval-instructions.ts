// Guidance for the agent's decision before it asks for approval. This is not
// a command classifier or an enforcement boundary; the user still approves.
export function approvalInstructions(engine: 'codex' | 'claude'): string {
  const common = '\nBefore each command approval request, assess whether a persistent permission would be appropriate, '
    + 'not just whether the current invocation is acceptable. Consider future matching arguments, executable resolution through PATH, '
    + 'configuration, hooks, plugins and other code the command may load. A stable command name or script path does not make its behavior immutable. '
    + 'If future runs could execute code the agent can change inside the sandbox, request one-time approval only. '
    + 'This includes running editable scripts, project tests and builds, and commands that load editable hooks or plugins. '
    + 'If uncertain, choose one-time approval. Do not broaden a prefix or create a wrapper to make a command eligible for a saved rule. '
    + 'Briefly explain the permission scope in the request. This assessment is your responsibility before each request; '
    + 'the connector does not classify command safety for you. Never edit permission rules yourself to avoid confirmation. ';
  return common + (engine === 'codex'
    ? 'When requesting escalation, omit prefix_rule for one-time-only approval. Supply a narrow prefix_rule only after this assessment '
      + 'supports future matching invocations. A proposed rule is not consent: the human must explicitly choose to save it.\n'
    : 'Riftjack currently supports only one-time Claude tool approvals; it does not save Claude permission rules. '
      + 'Do not promise a persistent grant or change settings to simulate one.\n');
}
