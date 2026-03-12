export const MIN_WORKSPACE_PANES = 1;

export function shouldEnsureInitialPane(): boolean {
  return MIN_WORKSPACE_PANES > 0;
}

export function canClosePane(currentPaneCount: number): boolean {
  return currentPaneCount > MIN_WORKSPACE_PANES;
}

export function closePaneLimitMessage(): string {
  return `至少保留${MIN_WORKSPACE_PANES}个终端`;
}
