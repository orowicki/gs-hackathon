import { Route, Routes } from "react-router-dom";
import { AlertDetailPage } from "./pages/alert-detail/AlertDetailPage";
import { LandingPage } from "./pages/LandingPage";
import { NewRulePage } from "./pages/NewRulePage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/alerts/:id" element={<AlertDetailPage />} />
      <Route path="/rules/new" element={<NewRulePage />} />
      <Route path="*" element={<LandingPage />} />
    </Routes>
  );
}
