import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { routes } from "./routes/registry";

export function App() {
  return (
    <AppShell>
      <Routes>
        {routes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
      </Routes>
    </AppShell>
  );
}
