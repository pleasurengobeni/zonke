// Anything drawn in DOM over the game canvas has to stop pointer events itself.
//
// Phaser listens for pointer events on the WINDOW, not only on its canvas, so an event
// that starts on an overlay still bubbles up and reaches whatever Phaser object happens to
// be under that point. A "Save" button in the middle of the screen sits directly over the
// menu behind it, and answering a prompt would quietly press a menu item too.
const POINTER_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'mousedown',
  'mouseup',
  'click',
  'touchstart',
  'touchend',
] as const;

export function swallowPointerEvents(element: HTMLElement): void {
  POINTER_EVENTS.forEach((type) => {
    // Bubble phase, so the overlay's own buttons still get their events first; this only
    // stops them travelling on to the window and into the game.
    element.addEventListener(type, (event) => event.stopPropagation());
  });
}
