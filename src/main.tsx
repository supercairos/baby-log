import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import "./i18n"; // initialize i18next before anything renders
import { ThemeProvider } from "./theme";
import App from "./App.tsx";

// Route under the runtime base path (BASE_URL is "/" or e.g. "/quick-ui/"), so deep links
// like /quick-ui/timeline resolve correctly. Strip the trailing slash for react-router.
const basename = import.meta.env.BASE_URL.replace(/\/+$/, "") || undefined;

// Server reads (running timers, timeline) are cached + background-refreshed by TanStack Query:
// it refetches on an interval, on window focus, and on reconnect, so another caregiver's
// change (e.g. stopping a timer) propagates to this device without a manual reload. Writes
// still go through the offline outbox; these queries just keep the read side fresh.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnReconnect: true,
      // Don't poll while the tab is hidden — save battery; focus refetch catches up on return.
      refetchIntervalInBackground: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={basename}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
