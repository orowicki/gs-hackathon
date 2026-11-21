import { Route, Routes } from "react-router-dom";
import { AlertDetailPage } from "./pages/AlertDetailPage";
import { FeedPage } from "./pages/feed/FeedPage";
import { NewRulePage } from "./pages/NewRulePage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<FeedPage />} />
      <Route path="/alerts/:id" element={<AlertDetailPage />} />
      <Route path="/rules/new" element={<NewRulePage />} />
      <Route path="*" element={<FeedPage />} />
    </Routes>
  );
}
