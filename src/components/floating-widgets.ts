// The floating widgets (AI Assistant, Chat) share the bottom-right corner:
// when one opens, the other closes and hides its launcher.

export type WidgetId = "assistant" | "chat";

type WidgetChange = { id: WidgetId; open: boolean };

const EVENT = "fm:floating-widget";

export function announceWidget(id: WidgetId, open: boolean): void {
  window.dispatchEvent(new CustomEvent<WidgetChange>(EVENT, { detail: { id, open } }));
}

/** Calls `onChange` when another widget opens or closes; returns an unsubscribe. */
export function onOtherWidget(self: WidgetId, onChange: (open: boolean) => void): () => void {
  const listener = (event: Event) => {
    const { id, open } = (event as CustomEvent<WidgetChange>).detail;
    if (id !== self) onChange(open);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
