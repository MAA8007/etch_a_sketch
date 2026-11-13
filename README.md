# Etch-a-Sketch

A drawing toy in the browser with two modes. Live at https://maa8007.github.io/etch_a_sketch/

## Pixels (`index.html`)

Pixel art on a grid, grown from the original hover-to-draw version.

- Draw by moving the mouse over the grid (or click and drag with Hover draw off). Touch works too.
- 24 colours, a rainbow brush, flood fill, eraser and undo.
- Grid sizes from 16 × 16 to 64 × 64. Changing size rescales the drawing.
- **Photo** turns a picture into pixel art: square crop, auto levels, then each pixel is matched to the nearest palette colour in CIELAB.
- Keyboard: `1`–`9` colours, `B` pen, `R` rainbow, `F` fill, `E` eraser, `G` grid lines, `Ctrl/Cmd+Z` undo.

## Toy (`toy.html`)

A classic red Etch A Sketch.

- Draw with the arrow keys or WASD (Shift for fine lines), by dragging the knobs, or on the screen.
- Shake to erase with the button, or by shaking your phone.

## Sending, replying and saving

- **Send** turns a drawing into a link, with an optional note. Opening it replays the drawing: pixel by pixel, or line by line on the toy.
- **Guess** mode hides the note until the other person guesses what the drawing is. Small typos are accepted, and the answer can list alternatives (`heart, love`).
- **Draw one back** replies in either mode. Each link carries the last few drawings, so both people see the thread.
- **Save** downloads a PNG or an animated GIF of the replay. The GIF encoder is written from scratch in `shared.js`.

Everything lives in the link itself: drawings are delta-encoded, deflated with `CompressionStream` and base64url-encoded into the URL hash. Nothing is stored on a server.

Plain HTML, CSS and JavaScript, no build step. Shared code is in `shared.js` and `shared.css`.
