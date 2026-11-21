import { Route, Routes } from "react-router-dom";
import { AlertDetailPage } from "./pages/alert-detail/AlertDetailPage";
import { LandingPage } from "./pages/LandingPage";
import { NewRulePage } from "./pages/NewRulePage";
import { SchemaEditPage, SchemasListPage } from "./pages/schemas/SchemasPage";
import { SourceEditPage, SourcesListPage } from "./pages/sources/SourcesPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/alerts/:id" element={<AlertDetailPage />} />
      <Route path="/rules/new" element={<NewRulePage />} />
      <Route path="/config/sources" element={<SourcesListPage />} />
      <Route path="/config/sources/:id" element={<SourceEditPage />} />
      <Route path="/config/schemas" element={<SchemasListPage />} />
      <Route path="/config/schemas/:id" element={<SchemaEditPage />} />
      <Route path="*" element={<LandingPage />} />
    </Routes>
  );
}
