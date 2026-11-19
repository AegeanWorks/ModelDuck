# Development notes

Moved out of the README to keep it under its size cap (it has no room for more).

## What `npm test` and `npm run ui:smoke` check

`npm test` also checks the control-panel wiring: every element the app looks up
exists, every ARIA reference resolves, the four control-panel dialogs are present,
and no chat shell or deleted chat route remains. `npm run ui:smoke` starts a
temporary ModelDuck and a headless Edge or Chrome, opens Models, Bench & Tune,
Settings and Server, checks all six Bench sections and 390px reflow, and fails on
a missing dialog or console exception. It needs Node 22+ and a Chromium browser;
without them it exits 1 unless you pass `-- --allow-skip`. The server, browser and
temporary data folder are cleaned up.
