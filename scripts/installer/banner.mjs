const WORDMARK = [
  "                                                                                ",
  "8b           d8  ,ad8888ba,   88888888ba 888888888888 88888888888 ,ad8888ba,    ",
  '`8b         d8\' d8"\'    `"8b  88      "8b     88      88         d8"\'    `"8b   ',
  " `8b       d8' d8'        `8b 88      ,8P     88      88        d8'        `8b  ",
  "  `8b     d8'  88          88 88aaaaaa8P'     88      88aaaaa   88          88  ",
  '   `8b   d8\'   88          88 88""""88\'       88      88"""""   88          88  ',
  "    `8b d8'    Y8,        ,8P 88    `8b       88      88        Y8,        ,8P  ",
  "     `888'      Y8a.    .a8P  88     `8b      88      88         Y8a.    .a8P   ",
  '      `8\'        `"Y8888Y"\'   88      `8b     88      88888888888 `"Y8888Y"\'',
];

const COMPACT_WORDMARK = [
  "1   1  111  1111  11111 11111  111 ",
  "1   1 1   1 1   1   1   1     1   1",
  "1   1 1   1 1111    1   1111  1   1",
  " 1 1  1   1 1 1     1   1     1   1",
  "  1    111  1  1    1   11111  111 ",
];

// Gradient noise gives each depth layer a smooth independent drift. No animation
// dependencies or random state are needed in the bootstrap installation path.
function noise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const gradient = (gx, gy, dx, dy) => {
    const hash = Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263);
    const angle = ((hash ^ (hash >>> 13)) & 255) * (Math.PI / 128);
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
  };
  const a = gradient(ix, iy, fx, fy);
  const b = gradient(ix + 1, iy, fx - 1, fy);
  const c = gradient(ix, iy + 1, fx, fy - 1);
  const d = gradient(ix + 1, iy + 1, fx - 1, fy - 1);
  const u = fade(fx);
  const v = fade(fy);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Terminal cells and green intensity bands, sized to leave room for real status. */
export function colliderFrame({ seconds, columns, rows, color }) {
  const width = Math.min(100, columns - 1);
  const height = Math.min(27, rows - 5);
  if (width < 60 || height < 15) return [];
  const grid = Array.from({ length: height }, () => Array(width).fill(" "));
  const bands = Array.from({ length: height }, () => Array(width).fill(0));
  const put = (x, y, c, band) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    grid[y][x] = c;
    bands[y][x] = band;
  };
  for (let y = 0; y < height - 2; y++) {
    for (let x = 1; x < width - 1; x++) {
      const depth =
        noise(x * 0.065 + seconds * 0.025, y * 0.13 - seconds * 0.018) +
        0.5 * noise(x * 0.15 - seconds * 0.016, y * 0.22 + seconds * 0.023) +
        0.22 * noise(x * 0.31 + seconds * 0.009, y * 0.32 + seconds * 0.011);
      if (depth > 0.15) put(x, y, ".:01|"[Math.min(4, Math.floor((depth - 0.15) * 9))], 1);
    }
  }
  const cy = (height - 4) / 2;
  for (let layer = 0; layer < 2; layer++) {
    for (let j = 0; j < 240; j++) {
      const angle = (j * Math.PI) / 120;
      const pulse =
        (((angle - seconds * (layer ? -0.17 : 0.23)) % (2 * Math.PI)) + 2 * Math.PI) %
        (2 * Math.PI);
      put(
        (width - 1) / 2 + (width / 2 - 2 - layer * 2) * Math.cos(angle),
        cy + (cy - layer) * Math.sin(angle),
        pulse < 0.12 ? "o" : ".",
        pulse < 0.12 ? 3 : 2,
      );
    }
  }
  for (let x = 10; x < width - 10; x += 5) {
    const head = (seconds * (0.7 + (x % 7) * 0.13) + x * 3) % (height - 3);
    for (let trail = 0; trail < 4; trail++) {
      const y = Math.floor((head - trail + height - 3) % (height - 3));
      put(x, y, "01:"[(x + trail + Math.floor(seconds * 3)) % 3], 3 - Math.min(2, trail));
    }
  }
  const full = width >= 90;
  const letters = full ? WORDMARK : COMPACT_WORDMARK;
  const wordWidth = Math.max(...letters.map((line) => line.length));
  const left = Math.floor((width - wordWidth) / 2);
  const top = Math.max(3, Math.floor(cy - letters.length / 2));
  for (const [y, row] of letters.entries()) {
    for (const [x, c] of [...row].entries()) {
      if (c === " ") continue;
      // Independent, slow fields make tile clusters wander without scanning in rows.
      // Keep every stroke occupied so animation never sacrifices the silhouette.
      const drift = noise(x * 0.21 + seconds * 0.035, y * 0.37 - seconds * 0.047);
      const shimmer = noise(x * 0.53 - seconds * 0.023 + 19, y * 0.61 + seconds * 0.031);
      const highlight = drift + 0.35 * shimmer;
      const glyph = highlight < -0.18 ? "▪" : "■";
      put(left + x, top + y, glyph, highlight > 0.22 ? 4 : 3);
    }
  }
  const footer = "YOUR MACHINE. YOUR AGENTS. YOUR COMMAND.";
  const footerLeft = Math.floor((width - footer.length) / 2);
  for (const [x, c] of [...footer].entries()) put(footerLeft + x, height - 1, c, 3);
  const colors = [
    "\u001b[0m",
    "\u001b[38;5;22m",
    "\u001b[38;5;28m",
    "\u001b[38;5;82m",
    "\u001b[38;5;120m",
  ];
  return grid.map((row, y) => {
    if (!color) return row.join("");
    let band = -1;
    let line = "";
    for (const [x, c] of row.entries()) {
      if (bands[y][x] !== band) {
        band = bands[y][x];
        line += colors[band];
      }
      line += c;
    }
    return line + "\u001b[0m";
  });
}
