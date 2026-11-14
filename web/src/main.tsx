import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
// Ambient smoke behind the page. It switches itself off on phones, under reduced motion and
// without WebGL2, and the page keeps a still glow instead.
import "./fluid.js";

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) document.documentElement.classList.add("motion");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
