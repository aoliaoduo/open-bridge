import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./theme";
import "./console.css";

// Before the first paint, not in an effect: a dark-desktop operator opening the
// console used to get a white flash on every load, which is exactly the moment
// the page is supposed to look calm.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
