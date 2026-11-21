import { Link, useParams } from "react-router-dom";

export function AlertDetailPage() {
  const { id } = useParams();
  return (
    <main className="page">
      <Link to="/">← Back to alerts</Link>
      <p className="muted mono">{id}</p>
    </main>
  );
}
