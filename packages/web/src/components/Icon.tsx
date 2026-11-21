import type { LucideIcon } from "lucide-react";

export function Icon({ as: Glyph }: { as: LucideIcon }) {
  return <Glyph size={16} strokeWidth={1.5} aria-hidden="true" />;
}
