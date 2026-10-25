import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "@mysten/dapp-kit/dist/index.css";
import "./index.css";
import { Shell } from "./components/shell.tsx";
import { Home } from "./pages/home.tsx";
import { Learned } from "./pages/learned.tsx";
import { NotFound } from "./pages/not-found.tsx";
import { PotPage } from "./pages/pot.tsx";
import { Providers } from "./providers.tsx";

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/pots/:id", element: <PotPage /> },
      { path: "/pots/:id/learned", element: <Learned /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("no #root");
createRoot(root).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
