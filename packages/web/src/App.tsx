import { Route, Routes } from "react-router-dom";
import { AlertDetailPage } from "./pages/AlertDetailPage";
import { LandingPage } from "./pages/LandingPage";
import { NewRulePage } from "./pages/NewRulePage";
import { SourceEditPage, SourcesListPage } from "./pages/sources/SourcesPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/alerts/:id" element={<AlertDetailPage />} />
      <Route path="/rules/new" element={<NewRulePage />} />
      <Route path="/config/sources" element={<SourcesListPage />} />
      <Route path="/config/sources/:id" element={<SourceEditPage />} />
      <Route path="*" element={<LandingPage />} />
    </Routes>
  );
}
