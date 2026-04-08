import { Routes, Route, NavLink } from "react-router-dom";
import { Home } from "./pages/Home";
import { Snapshots } from "./pages/Snapshots";

export function App() {
  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-brand">TokTrace</span>
        <NavLink to="/" end>
          Overview
        </NavLink>
        <NavLink to="/snapshots">Snapshots</NavLink>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/snapshots" element={<Snapshots />} />
        </Routes>
      </main>
    </div>
  );
}
