// Two synthetic brand hosts from one build: the same engine code, rendered from
// each host's environment alone (through the real configuration parser),
// gives visibly different shells and homes.
import { render, screen, within } from "@testing-library/react";
import {
  hostHome,
  hostPresentation,
  resetWalletHostCache,
} from "@/api/wallet-host";
import { AppShell } from "@/app/_components/app-shell";
import { HostHome } from "@/app/_components/host/host-home";
import { HostProvider } from "@/app/_providers/host-provider";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  morrowDocument,
  tidewellDocument,
  type HostDocument,
} from "@/test/wallet-host-fixtures";

jest.mock("next-intl", () => jest.requireActual("@/test/intl-mock").intlMock);
jest.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ replace: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/app/_providers/session-provider", () => ({
  useSession: () => ({
    wallet: null,
    isLoading: false,
    isAuthenticated: true,
    logout: jest.fn(),
  }),
}));
jest.mock("@/app/_providers/theme-provider", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: jest.fn() }),
}));

afterEach(() => {
  clearHostEnvironment();
  resetWalletHostCache();
});

function renderHost(configuration: HostDocument) {
  resetWalletHostCache();
  applyHostEnvironment(hostEnvironment(configuration));
  const host = hostPresentation()!;
  const home = hostHome()!;
  const shell = render(
    <HostProvider host={host}>
      <AppShell>content</AppShell>
    </HostProvider>,
  );
  const sidebar = shell.container.querySelector("aside") as HTMLElement;
  const seen = {
    name: within(sidebar).getByText(host.brand.name).textContent,
    logo: sidebar.querySelector("img")?.getAttribute("src"),
    navigation: within(
      screen.getByRole("navigation", { name: "Main navigation" }),
    )
      .getAllByRole("link")
      .map((link) => link.textContent),
    themeSwitch: screen.queryByRole("button", { name: "Change color theme" }),
  };
  shell.unmount();
  const page = render(<HostHome home={home} />);
  const homeSeen = {
    headline: screen.getByRole("heading", { level: 1 }).textContent,
    primary: screen
      .getAllByRole("link")
      .filter((link) => link.className.includes("button-primary"))
      .map((link) => [link.textContent, link.getAttribute("href")]),
  };
  page.unmount();
  return { ...seen, ...homeSeen };
}

it("renders two visibly different shells and homes from one build", () => {
  const morrow = renderHost(morrowDocument());
  const tidewell = renderHost(tidewellDocument());

  expect(morrow).toEqual({
    name: "Morrow Home",
    logo: expect.stringMatching(/^\/api\/host\/logo\/[0-9a-f]{64}$/),
    navigation: ["Inventory", "Products", "Activity", "Settings"],
    themeSwitch: null,
    headline: "Your Morrow Home tools, registered and cared for.",
    primary: [["Register a product", "/products/morrow-home/register"]],
  });
  expect(tidewell).toEqual({
    name: "Tidewell",
    logo: expect.stringMatching(/^\/api\/host\/logo\/[0-9a-f]{64}$/),
    navigation: ["Products", "Settings"],
    themeSwitch: null,
    headline: "Every Tidewell kettle you own, in one place.",
    primary: [["See my products", "/products/tidewell-care/products"]],
  });
  // Different logo bytes, so a different content address.
  expect(morrow.logo).not.toBe(tidewell.logo);
});
