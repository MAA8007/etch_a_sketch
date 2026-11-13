# Etch-a-Sketch

A drawing toy in the browser with two modes. Live at https://maa8007.github.io/etch_a_sketch/

## Pixels (`index.html`)

Pixel art on a grid, grown from the original hover-to-draw version.

- Draw by moving the mouse over the grid (or click and drag with Hover draw off). Touch works too.
- 12 colours, a rainbow brush, flood fill, eraser and undo.
- Grid sizes from 16 × 16 to 64 × 64. Changing size rescales the drawing.
- Keyboard: `1`–`9` colours, `B` pen, `R` rainbow, `F` fill, `E` eraser, `G` grid lines, `Ctrl/Cmd+Z` undo.

## Toy (`toy.html`)

A classic red Etch A Sketch.

- Draw with the arrow keys or WASD (Shift for fine lines), by dragging the knobs, or on the screen.
- Shake to erase with the button, or by shaking your phone.

## Sharing

Both modes can turn a drawing into a link, with an optional note. The drawing is compressed into the URL itself, so nothing is stored on a server. Opening the link replays the drawing: pixel by pixel in Pixels mode, line by line in Toy mode.

Plain HTML, CSS and JavaScript, no build step.
