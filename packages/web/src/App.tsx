import { Route, Routes } from "react-router-dom";
import { AlertDetailPage } from "./pages/alert-detail/AlertDetailPage";
import { FeedPage } from "./pages/feed/FeedPage";
import { NewRulePage } from "./pages/NewRulePage";
import { SchemaEditPage, SchemasListPage } from "./pages/schemas/SchemasPage";
import { SourceEditPage, SourcesListPage } from "./pages/sources/SourcesPage";
import { ChannelsPage } from "./pages/channels/ChannelsPage";
import { MyNotificationsPage } from "./pages/my-notifications/MyNotificationsPage";
import { PeoplePage } from "./pages/people/PeoplePage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<FeedPage />} />
      <Route path="/alerts/:id" element={<AlertDetailPage />} />
      <Route path="/rules/new" element={<NewRulePage />} />
      <Route path="/config/sources" element={<SourcesListPage />} />
      <Route path="/config/sources/:id" element={<SourceEditPage />} />
      <Route path="/config/schemas" element={<SchemasListPage />} />
      <Route path="/config/schemas/:id" element={<SchemaEditPage />} />
      <Route path="/config/people" element={<PeoplePage />} />
      <Route path="/config/channels" element={<ChannelsPage />} />
      <Route path="/settings/notifications" element={<MyNotificationsPage />} />
      <Route path="*" element={<FeedPage />} />
    </Routes>
  );
}
