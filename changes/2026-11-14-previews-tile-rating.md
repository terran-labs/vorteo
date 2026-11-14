### Improvements

- Move the star rating onto each Previews tile, over the bottom left of its thumbnail. With a mouse the five stars appear when the tile is hovered and light up to the star under the pointer; a saved rating stays visible as a small chip. On a touch screen, tapping the chip opens the stars and tapping the tile still opens the preview.

## Maintenance review

Owner-requested interface change to the Previews card. The rating is a sibling of the thumbnail button, so rating never opens the preview, and it uses the existing tile hover group mechanism. The browser test project runs with stand-in styles and icons, so only behaviour was exercised there (five stars, set, clear); the appearance has not been checked in a rendered interface. README overview and onboarding are unchanged.
