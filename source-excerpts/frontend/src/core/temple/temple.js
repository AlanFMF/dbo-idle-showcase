const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createTempleController({ state, onChange, sendPosition }) {
  let target = null;
  let frame = 0;
  const pressed = new Set();

  function move(dx, dy) {
    state.temple.x = clamp(state.temple.x + dx, 5, 95);
    state.temple.y = clamp(state.temple.y + dy, 12, 88);
    onChange();
    sendPosition?.(state.temple.x, state.temple.y);
  }

  function tick() {
    let dx = 0, dy = 0;
    if (pressed.has('ArrowLeft') || pressed.has('a')) dx -= .45;
    if (pressed.has('ArrowRight') || pressed.has('d')) dx += .45;
    if (pressed.has('ArrowUp') || pressed.has('w')) dy -= .45;
    if (pressed.has('ArrowDown') || pressed.has('s')) dy += .45;
    if (target) {
      const tx = target.x - state.temple.x;
      const ty = target.y - state.temple.y;
      const distance = Math.hypot(tx, ty);
      if (distance < 1) target = null;
      else {
        dx += tx / distance * .55;
        dy += ty / distance * .55;
      }
    }
    if (dx || dy) move(dx, dy);
    frame = requestAnimationFrame(tick);
  }

  function keyDown(event) {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    pressed.add(event.key.toLowerCase());
  }
  function keyUp(event) { pressed.delete(event.key.toLowerCase()); }

  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  frame = requestAnimationFrame(tick);

  return {
    walkTo(x, y) { target = { x, y }; },
    destroy() {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
    }
  };
}
