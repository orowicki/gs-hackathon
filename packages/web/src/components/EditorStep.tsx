import type { ReactNode } from "react";

/**
 * One numbered step of a configuration editor (rules, sources...): number, heading,
 * one line of help, then the controls. Lay steps out in .re-layout > .re-steps, with a
 * .re-summary beside them (styles in styles/components.css).
 */
export function Step({ n, title, help, children }: { n: number; title: string; help: string; children: ReactNode }) {
  const id = "step-" + title.toLowerCase().replace(/\W+/g, "-");
  return (
    <section className="re-step" aria-labelledby={id}>
      <div className="re-step-num" aria-hidden="true">
        {n}
      </div>
      <div className="re-step-body">
        <h2 id={id}>{title}</h2>
        <p className="re-help">{help}</p>
        {children}
      </div>
    </section>
  );
}
