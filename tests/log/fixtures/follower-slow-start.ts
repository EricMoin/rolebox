import { setTimeout as sleep } from "node:timers/promises";
// Exceed the probe's former fixed 250 ms startup wait before the real CLI loads.
await sleep(750);

export {};
