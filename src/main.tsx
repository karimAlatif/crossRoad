import { createRoot } from "react-dom/client";
import App from "./App";
import "./ui/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// No StrictMode on purpose: its development double-mount would spin up a second
// Babylon engine and re-download the 16 MB city. App's effect still cleans up
// correctly if it is ever reinstated.
createRoot(container).render(<App />);
