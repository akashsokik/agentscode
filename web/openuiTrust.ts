/**
 * Whether an openui-lang block renders as live UI. Its buttons send their text to the agent as if
 * you typed it, so only the agent's own replies may draw them; text another agent wrote (a
 * teammate's message shown in this transcript) keeps the block as code. Pure, so it is tested.
 */
export function openUiLive(isOpenUiFence: boolean, fromAnotherAgent: boolean): boolean {
  return isOpenUiFence && !fromAnotherAgent;
}
