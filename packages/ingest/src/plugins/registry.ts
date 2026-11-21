import type { SourcePlugin } from "../types.js";

const plugins = new Map<string, SourcePlugin<never>>();

export function registerSourcePlugin<C>(plugin: SourcePlugin<C>): void {
  plugins.set(plugin.type, plugin as SourcePlugin<never>);
}

export function getSourcePlugin(type: string): SourcePlugin | undefined {
  return plugins.get(type) as SourcePlugin | undefined;
}

export function listSourcePlugins(): SourcePlugin[] {
  return [...plugins.values()] as SourcePlugin[];
}
