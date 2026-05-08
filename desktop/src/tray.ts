import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { refreshUsage } from "./api";

let installed = false;

export async function installTray() {
  if (installed) return;
  installed = true;

  const handleMenu = async (id: string) => {
    switch (id) {
      case "open":
      case "settings":
      case "providers":
        await showWindow("main");
        break;
      case "widget":
        await showWindow("widget");
        break;
      case "refresh":
        await refreshUsage();
        break;
      case "quit":
        await getCurrentWindow().close();
        break;
    }
  };

  const menu = await Menu.new({
    items: [
      { id: "open", text: "Open Monitor", action: handleMenu },
      { id: "widget", text: "Show Widget", action: handleMenu },
      { id: "refresh", text: "Refresh", action: handleMenu },
      { id: "settings", text: "Settings", action: handleMenu },
      { id: "providers", text: "Providers", action: handleMenu },
      { id: "quit", text: "Quit", action: handleMenu }
    ]
  });

  await TrayIcon.new({
    tooltip: "Simple AI Usage Monitor",
    menu,
    showMenuOnLeftClick: false,
    action: async (event) => {
      if (event.type === "Click" && event.button === "Left" && event.buttonState === "Up") {
        await showWindow("main");
      }
    }
  });
}

export async function showWindow(label: "main" | "widget") {
  const existing = await Window.getByLabel(label);
  if (existing) {
    await existing.show();
    await existing.setFocus();
  }
}
