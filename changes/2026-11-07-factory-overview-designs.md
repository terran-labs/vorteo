### Features

- The Factory Overview offers three designs to compare, chosen at the top of the page and remembered on this device: Floor (board first), Mission (dashboard first) and Ledger (a dense operator view with a control rail). Each keeps every existing control and shows the work as status lanes with compact issue cards, a five-step track, pull request checks and review state, agent threads to open, "Needs you" and repair badges, and claims held by another installation.
- Reports show velocity, cycle time, token use by work category, quota windows per provider account with reset times, estimated API-equivalent dollars, budgets, cost per merged pull request, check pass rate and model routing. Queue, quota, open-thread usage and routing are live; history, caps and account picks are sample figures, and every sample-backed tile says so.
- A Sample factory switch replaces the live queue with a fixed sample queue so the designs can be judged when the real queue is short. Controls still act on the real Factory.

## Maintenance review

Factory Overview redesign, interface only: no server, protocol or plugin changes. PageLayout gains an optional `wide` column (1440px) used only here; the default stays 720px. One focused test covers lane mapping and the five-step track. README overview and onboarding are unchanged. Not installed. Layout fixes after visual review: lanes share the board width with a horizontal scroll past six readable lanes, report panels shrink to the phone column, and sample tags sit on their own row in figure tiles.
