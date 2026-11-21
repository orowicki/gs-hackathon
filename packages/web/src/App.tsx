import { Route, Routes } from "react-router-dom";
import { AlertDetailPage } from "./pages/AlertDetailPage";
import { LandingPage } from "./pages/LandingPage";
import { NewRulePage } from "./pages/NewRulePage";
import { ChannelsPage } from "./pages/channels/ChannelsPage";
import { MyNotificationsPage } from "./pages/my-notifications/MyNotificationsPage";
import { PeoplePage } from "./pages/people/PeoplePage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/alerts/:id" element={<AlertDetailPage />} />
      <Route path="/rules/new" element={<NewRulePage />} />
      <Route path="/config/people" element={<PeoplePage />} />
      <Route path="/config/channels" element={<ChannelsPage />} />
      <Route path="/settings/notifications" element={<MyNotificationsPage />} />
      <Route path="*" element={<LandingPage />} />
    </Routes>
  );
}
