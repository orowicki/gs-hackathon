// Separate process with its own Redis connection: prints the first ConfigChange it receives.
import { Redis } from "ioredis";
const [channel] = process.argv.slice(2);
const sub = new Redis(process.env.REDIS_URL);
sub.on("message", (_c, m) => {
  console.log(m);
  sub.disconnect();
});
await sub.subscribe(channel);
console.log("READY");
