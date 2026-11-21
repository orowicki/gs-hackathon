import { Route, Routes } from "react-router-dom";
import { routes } from "./routes/registry";

export function App() {
  return (
    <Routes>
      {routes.map((r) => (
        <Route key={r.path} path={r.path} element={r.element} />
      ))}
    </Routes>
  );
}
