// Keep buttons of an inline confirmation call this before closing it, so
// focus returns to the button that opened the confirmation (it carries
// aria-expanded="true" while the confirmation is open) instead of falling
// back to the page when the confirmation disappears.
export function returnFocusToConfirmTrigger(keepButton: HTMLElement): void {
  keepButton
    .closest('.confirm-panel')
    ?.parentElement?.querySelector<HTMLElement>('[aria-expanded="true"]')
    ?.focus();
}
