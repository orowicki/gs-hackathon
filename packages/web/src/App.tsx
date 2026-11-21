import { Route, Routes } from "react-router-dom";
import { AccountProvider, useAccount } from "./account";
import { AppShell } from "./components/AppShell";
import { SignInPage } from "./pages/sign-in/SignInPage";
import { routes } from "./routes/registry";

export function App() {
  return (
    <AccountProvider>
      <Gate />
    </AccountProvider>
  );
}

/** Signed out: the sign-in page instead of the app. */
function Gate() {
  const { state } = useAccount();
  if (state.status === "loading") return <div className="app-loading" aria-busy="true" />;
  if (state.status === "signedOut") return <SignInPage />;
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
