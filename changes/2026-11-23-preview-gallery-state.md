### Features

- Live-link tiles on the Previews gallery now show their preview's state, such as Stopped, Starting, Not responding or Link withdrawn, as a small badge over the thumbnail. An old report shows a dimmed badge, and a running preview whose report is old reads "Not current". Opening the tile shows the same sentence and button as the scripts menu: Start, Try again, Restart with its confirmation, or Stop (#586).

## Maintenance review

Updated the private workspace previews entry with the gallery state. A tile is matched to a script only when its link's origin exactly equals one reserved service's `preview.origin` across every workspace the app holds for that host; any second claim, a different port or plain http matches nothing. The daemon already drops duplicated origins (#599), so this is a second layer. Strings stay in the preview status module, English in every locale until the owner approves them. Cases extend the gallery model test and the key-level table test. Interface only, after the daemon from #599 is installed. README overview and onboarding are unchanged. Not published.
