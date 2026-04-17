import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";

// Sin StrictMode: en React 18 el modo estricto re-ejecuta efectos en desarrollo
// (montaje → cleanup → montaje), duplicando cargas HLS/stream en el preview.
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/*" element={<App />} />
    </Routes>
  </BrowserRouter>,
);
