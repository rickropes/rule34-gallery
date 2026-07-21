import { NavLink } from "react-router-dom";

const links = [
  { name: "Gallery", path: "/" },
  { name: "Settings", path: "/settings" },
];

export default function Sidebar() {
  return (
    <aside className="w-64 border-r border-zinc-800 bg-zinc-950">
      <div className="p-6">
        <h1 className="text-xl font-bold text-white">
          Rule34 Library
        </h1>
      </div>

      <nav className="flex flex-col gap-1 p-2">
        {links.map((link) => (
          <NavLink
            key={link.path}
            to={link.path}
            end={link.path === "/"}
            className={({ isActive }) =>
              [
                "rounded-lg px-4 py-3 transition-colors",
                isActive
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-white",
              ].join(" ")
            }
          >
            {link.name}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}