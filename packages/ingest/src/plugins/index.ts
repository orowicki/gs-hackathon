import { registerSourcePlugin } from "./registry.js";
import { httpPlugin } from "./http.js";
import { fileTailPlugin } from "./file-tail.js";
import { redisStreamPlugin } from "./redis-stream.js";
import { kafkaPlugin } from "./kafka.js";

export * from "./http.js";
export * from "./file-tail.js";
export * from "./redis-stream.js";
export * from "./kafka.js";

export function registerBuiltinPlugins(): void {
  registerSourcePlugin(httpPlugin);
  registerSourcePlugin(fileTailPlugin);
  registerSourcePlugin(redisStreamPlugin);
  registerSourcePlugin(kafkaPlugin);
}
