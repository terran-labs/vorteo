// Owner-authorized fallback migrations. Versioned assets remain immutable.
// Changing this table requires another reviewed migration. `before` lists every
// earlier reviewed digest an installation may still serve; an empty list admits
// only a first publication of that alias.
export const fallbackIcons = Object.freeze({
  "favicon.ico": {
    before: ["82b2ff4808fb2ccf456e63d4ef0a185d8fac84fc04154835ce6bbd813bfc4561"],
    after: "8940419acf65e63eff203cddb3895c0df21c13b17691713f9d14cd9ff8fbb7d5",
  },
  // 2026-11-05: 1024px touch icon so Unite builds a sharp macOS icon.
  "apple-touch-icon.png": {
    before: [
      "5dc51d49f2c2bb7a0b12458d703d1c227a92b3324bd7ea23fc953c24f86513ce",
      "0567fc90453dc9ee254dd11927a3bb22a64f68d3c8b0d187d926a4273ffbf8b8",
    ],
    after: "c9c2d0d9877c5f6c66664b1c09e51679fba52aaaf2a527755f2c278fd4da9e9b",
  },
  // Unite probes these names before apple-touch-icon.png; they used to fall
  // through to the HTML shell.
  "apple-touch-icon-precomposed.png": {
    before: [],
    after: "c9c2d0d9877c5f6c66664b1c09e51679fba52aaaf2a527755f2c278fd4da9e9b",
  },
  "touch-icon-iphone.png": {
    before: [],
    after: "c9c2d0d9877c5f6c66664b1c09e51679fba52aaaf2a527755f2c278fd4da9e9b",
  },
  "pwa-icon-192.png": {
    before: ["e0d07845345b222180a8a56ffcc7930981cfd11381f3db99a66ffd698659d328"],
    after: "e9f5a90841f69d01f3a18a89b95f095fa6f85eab7b93030da9aaae6980a248af",
  },
  "pwa-icon-512.png": {
    before: ["740bd4985344ee18090544507db11ebc5f7d209f64172872a9aaf17cdb83687c"],
    after: "1dace8888c479848606183c9f5d7d20ff670f09f70cf8306f0c57c2757e9f3bb",
  },
});

export function isReviewedFallback(name, previousHash, nextHash) {
  if (!Object.hasOwn(fallbackIcons, name)) return false;
  const approved = fallbackIcons[name];
  if (
    nextHash !== approved.after ||
    (previousHash !== null &&
      !approved.before.includes(previousHash) &&
      previousHash !== approved.after)
  ) {
    throw new Error(`Unreviewed fallback icon migration: ${name}`);
  }
  return true;
}
