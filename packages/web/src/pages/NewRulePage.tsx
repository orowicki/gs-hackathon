import { Link } from "react-router-dom";

export function NewRulePage() {
  return (
    <main className="page">
      <Link to="/">← Back to alerts</Link>
      <h1>New rule</h1>
      <p className="muted">Rule creation is specified separately.</p>
    </main>
  );
}
